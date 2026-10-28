package kr.webnavi.kakaosafety

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.LocationManager
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import com.kakaomobility.knsdk.KNLanguageType
import com.kakaomobility.knsdk.KNRoutePriority
import com.kakaomobility.knsdk.KNSDK
import com.kakaomobility.knsdk.guidance.knguidance.KNGuidance
import com.kakaomobility.knsdk.guidance.knguidance.KNGuidance_LocationGuideDelegate
import com.kakaomobility.knsdk.guidance.knguidance.KNGuidance_SafetyGuideDelegate
import com.kakaomobility.knsdk.guidance.knguidance.KNGuidance_VoiceGuideDelegate
import com.kakaomobility.knsdk.guidance.knguidance.locationguide.KNGuide_Location
import com.kakaomobility.knsdk.guidance.knguidance.safetyguide.KNGuide_Safety
import com.kakaomobility.knsdk.guidance.knguidance.safetyguide.objects.KNSafety
import com.kakaomobility.knsdk.guidance.knguidance.safetyguide.objects.KNSafety_Camera
import com.kakaomobility.knsdk.guidance.knguidance.voiceguide.KNGuide_Voice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * One car's 카카오 안전운전, on one emulator (kakao-safety/README.md). The nav server hands this slot a car's fixes; the
 * container's feeder.py puts them in as this device's GPS, the 내비 SDK runs its no-destination 안전운전 over them, and what it would say of a camera
 * — and the cameras it has ahead — go back to the server, to be said in the car if our own lists have not said them.
 * Nothing is kept: each answer is used as it comes (카카오's terms for the SDK's safety data).
 */
class SafetyService : Service(), KNGuidance_SafetyGuideDelegate, KNGuidance_LocationGuideDelegate, KNGuidance_VoiceGuideDelegate {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var base: String
    private var slot = 1
    private var token = ""

    private var appKey = ""
    private var initState = "none" // none, pending, ok, error
    private var failedAt = 0L
    private var guiding = false
    private var activeSince = 0L
    private var inactiveSince = 0L
    private var latest: List<KNSafety> = emptyList()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Restarted by the system after a crash (START_STICKY), the intent is null: the slot, server and token it was
        // started with are read back. Without them slot 3's app came back as slot 1 with no token, and asked nothing
        // for nine hours (2026-10-28).
        val kept = getSharedPreferences("start", 0)
        if (intent?.hasExtra("slot") == true) {
            kept.edit().putString("base", intent.getStringExtra("base")).putInt("slot", intent.getIntExtra("slot", 1)).putString("token", intent.getStringExtra("token")).apply()
        }
        base = kept.getString("base", null) ?: "http://10.0.2.2:8099"
        slot = kept.getInt("slot", 1)
        token = kept.getString("token", null) ?: ""
        startAsForeground()
        scope.coroutineContext[kotlinx.coroutines.Job]?.children?.forEach { it.cancel() }
        clearMockProviders()
        scope.launch { loop() }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun startAsForeground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("safety", "안전운전", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, "safety").setContentTitle("카카오 안전운전 슬롯 $slot").setSmallIcon(android.R.drawable.ic_menu_mylocation).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) else startForeground(1, n)
    }

    /** The server's word for this slot, again and again: its car's newest fix, whether it is driving, and the app key. */
    private suspend fun loop() {
        var after = 0L
        while (scope.isActive) {
            val answer = withContext(Dispatchers.IO) {
                runCatching { http("GET", "$base/internal/kakao/slot/$slot?after=$after&wait=10", null) }.getOrNull()
            }
            if (answer == null) { delay(2000); continue }
            val j = runCatching { JSONObject(answer) }.getOrNull() ?: continue
            val key = j.optString("appKey")
            // A refusal is asked again after five minutes, not at every answer: a key typed anew is tried at once.
            // An initialisation whose completion never comes (카카오 unreachable) is given up after a minute.
            if (initState == "pending" && SystemClock.elapsedRealtime() - failedAt > 60_000) { initState = "error"; status("error", "초기화 응답 없음 (1분)") }
            val retry = initState == "error" && SystemClock.elapsedRealtime() - failedAt > 5 * 60_000
            if (key.isNotEmpty() && (key != appKey || retry) && initState != "pending") initialize(key)
            j.optJSONObject("fix")?.let { fix -> after = fix.optLong("seq", after) }
            val active = j.optBoolean("active")
            val now = SystemClock.elapsedRealtime()
            if (active) { inactiveSince = 0; if (activeSince == 0L) activeSince = now } else { activeSince = 0; if (inactiveSince == 0L) inactiveSince = now }
            // 안전운전 runs while a car is on this slot; it is stopped half a minute after (a quota of starts, not of time).
            if (active && initState == "ok" && !guiding) startGuidance()
            if (!active && guiding && now - inactiveSince > 30_000) stopGuidance()
        }
    }

    private fun initialize(key: String) {
        appKey = key
        initState = "pending"
        failedAt = SystemClock.elapsedRealtime()
        status("init", "초기화 중")
        try {
            KNSDK.install(application, "${filesDir}/knsdk")
            val user = getSharedPreferences("kakao", 0).let { p ->
                p.getString("user", null) ?: "webnavi-slot$slot-${System.currentTimeMillis()}".also { p.edit().putString("user", it).apply() }
            }
            KNSDK.initializeWithAppKey(key, "1.0", user, aLangType = KNLanguageType.KNLanguageType_KOREAN, aCompletion = { error ->
                scope.launch {
                    if (error == null) {
                        initState = "ok"
                        status("ready", "초기화 완료")
                    } else {
                        initState = "error"
                        failedAt = SystemClock.elapsedRealtime()
                        // What this app shows 카카오: the package and its signing key's hash, to set beside the 플랫폼 키's.
                        status("error", "초기화 실패 ${error.code} ${error.msg ?: ""} ${error.tagMsg ?: ""} · 패키지 $packageName · 키 해시 ${keyHash()}".trim())
                    }
                }
            })
        } catch (t: Throwable) {
            initState = "error"
            failedAt = SystemClock.elapsedRealtime()
            status("error", "초기화 예외 ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    private fun startGuidance() {
        val g = KNSDK.sharedGuidance() ?: run { status("error", "안내 객체 없음"); return }
        g.safetyGuideDelegate = this
        g.locationGuideDelegate = this
        g.voiceGuideDelegate = this
        g.useDirSound = false
        // No trip: the SDK's 안전운전 (목적지 없이), along the road it matches the car to.
        g.startWithTrip(null, KNRoutePriority.KNRoutePriority_Recommand, 0)
        guiding = true
        status("guiding", "안전운전 중")
    }

    private fun stopGuidance() {
        KNSDK.sharedGuidance()?.let { g ->
            runCatching { g.stop() }
            g.safetyGuideDelegate = null
            g.locationGuideDelegate = null
            g.voiceGuideDelegate = null
        }
        guiding = false
        latest = emptyList()
        status("ready", "쉬는 중")
    }

    /** The app's signing certificate as Kakao hashes it: SHA-1, Base64. */
    private fun keyHash(): String = runCatching {
        @Suppress("DEPRECATION")
        val signs = if (Build.VERSION.SDK_INT >= 28) packageManager.getPackageInfo(packageName, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES).signingInfo!!.apkContentsSigners
        else packageManager.getPackageInfo(packageName, android.content.pm.PackageManager.GET_SIGNATURES).signatures!!
        android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-1").digest(signs[0].toByteArray()), android.util.Base64.NO_WRAP)
    }.getOrDefault("?")

    // ---- the car's position ----
    // Not put in here: the SDK takes no location an app marks as mock (KNGPSManager reads Location.isMock()). The
    // container's feeder.py puts each fix into the emulator's own GPS instead. A test provider an older build left
    // would stand in front of that GPS: taken away at start.

    private fun clearMockProviders() {
        val lm = getSystemService(LocationManager::class.java)
        for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) runCatching { lm.removeTestProvider(p) }
    }

    // ---- what the SDK says ----

    override fun guidanceDidUpdateSafetyGuide(guidance: KNGuidance, safetyGuide: KNGuide_Safety?) {
        latest = safetyGuide?.safetiesOnGuide.orEmpty().toList()
    }

    override fun guidanceDidUpdateAroundSafeties(guidance: KNGuidance, safeties: List<KNSafety>?) = Unit

    /** Only what the SDK would say is sent (shouldPlayVoiceGuide): the cameras ahead are its to time, as our own lists'. */
    override fun guidanceDidUpdateLocation(guidance: KNGuidance, locationGuide: KNGuide_Location) = Unit

    /**
     * The SDK would speak now: what of is told (a camera's, a zone's warning), and its sound let go — the car says it in
     * its own voice, if its own lists have not.
     */
    override fun shouldPlayVoiceGuide(guidance: KNGuidance, voiceGuide: KNGuide_Voice, strings: MutableList<ByteArray>): Boolean {
        val s = voiceGuide.guideObj as? KNSafety
        val d = s?.let { runCatching { guidance.locationGuide?.location?.distToLocation(it.location) }.getOrNull() }
        val e = JSONObject().put("voiceCode", voiceGuide.voiceCode?.name ?: "").put("voiceDist", voiceGuide.voiceDist?.name ?: "")
        if (s != null) e.put("safety", describe(s, d ?: -1))
        post("voice", e)
        return false
    }

    override fun willPlayVoiceGuide(guidance: KNGuidance, voiceGuide: KNGuide_Voice) = Unit
    override fun didFinishPlayVoiceGuide(guidance: KNGuidance, voiceGuide: KNGuide_Voice) = Unit

    private fun describe(s: KNSafety, dist: Int): JSONObject {
        val pos = s.location.pos
        val wgs = KNSDK.convertKATECToWGS84(pos.x.toInt(), pos.y.toInt())
        return JSONObject()
            .put("id", s.safetyId)
            .put("code", s.code.name)
            .put("lon", wgs.x)
            .put("lat", wgs.y)
            .put("limit", (s as? KNSafety_Camera)?.speedLimit ?: 0)
            .put("dist", dist)
            .put("road", s.location.roadName ?: "")
    }

    // ---- to the server ----

    private fun post(kind: String, body: JSONObject) {
        body.put("kind", kind)
        scope.launch(Dispatchers.IO) { runCatching { http("POST", "$base/internal/kakao/slot/$slot/event", body.toString()) } }
    }

    private fun status(state: String, detail: String) {
        Log.i("KakaoSafety", "slot $slot $state: $detail")
        post("status", JSONObject().put("state", state).put("detail", detail))
    }

    private fun http(method: String, url: String, body: String?): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 5000
        c.readTimeout = 20_000
        c.setRequestProperty("X-Kakao-Token", token)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        return try { c.inputStream.bufferedReader().readText() } finally { c.disconnect() }
    }
}
