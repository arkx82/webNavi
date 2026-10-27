package kr.webnavi.kakaosafety

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Criteria
import android.location.Location
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
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * One car's 카카오 안전운전, on one emulator (kakao-safety/README.md). The nav server hands this slot a car's fixes; they are
 * put in as this device's GPS, the 내비 SDK runs its no-destination 안전운전 over them, and what it would say of a camera
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
    private var guiding = false
    private var activeSince = 0L
    private var inactiveSince = 0L
    private var latest: List<KNSafety> = emptyList()
    private var aheadSentAt = 0L
    private var lastFixAt = 0L
    private var lastFix: JSONObject? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        base = intent?.getStringExtra("base") ?: "http://10.0.2.2:8099"
        slot = intent?.getIntExtra("slot", 1) ?: 1
        token = intent?.getStringExtra("token") ?: ""
        startAsForeground()
        scope.coroutineContext[kotlinx.coroutines.Job]?.children?.forEach { it.cancel() }
        scope.launch { loop() }
        scope.launch { keepPositionFresh() }
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
            if (key.isNotEmpty() && (key != appKey || initState == "error") && initState != "pending") initialize(key)
            j.optJSONObject("fix")?.let { fix ->
                after = fix.optLong("seq", after)
                lastFix = fix
                lastFixAt = SystemClock.elapsedRealtime()
                putPosition(fix)
            }
            val active = j.optBoolean("active")
            val now = SystemClock.elapsedRealtime()
            if (active) { inactiveSince = 0; if (activeSince == 0L) activeSince = now } else { activeSince = 0; if (inactiveSince == 0L) inactiveSince = now }
            // 안전운전 runs while a car is on this slot; it is stopped half a minute after (a quota of starts, not of time).
            if (active && initState == "ok" && !guiding) startGuidance()
            if (!active && guiding && now - inactiveSince > 30_000) stopGuidance()
        }
    }

    /** The fix put in again each second while the car is on this slot: a position goes stale to the SDK between fixes. */
    private suspend fun keepPositionFresh() {
        while (scope.isActive) {
            delay(1000)
            val fix = lastFix ?: continue
            val age = SystemClock.elapsedRealtime() - lastFixAt
            if (age in 1100..5000) putPosition(fix)
        }
    }

    private fun initialize(key: String) {
        appKey = key
        initState = "pending"
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
                        status("error", "초기화 실패 ${error.code} ${error.msg ?: ""} ${error.tagMsg ?: ""}".trim())
                    }
                }
            })
        } catch (t: Throwable) {
            initState = "error"
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

    // ---- the car's position as this device's ----

    private var providerReady = false
    private fun putPosition(fix: JSONObject) {
        val lm = getSystemService(LocationManager::class.java)
        try {
            if (!providerReady) {
                for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                    runCatching { lm.removeTestProvider(p) }
                    @Suppress("DEPRECATION")
                    lm.addTestProvider(p, false, p == LocationManager.GPS_PROVIDER, false, false, true, true, true, Criteria.POWER_LOW, Criteria.ACCURACY_FINE)
                    lm.setTestProviderEnabled(p, true)
                }
                providerReady = true
            }
            for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
                val l = Location(p).apply {
                    latitude = fix.getDouble("lat")
                    longitude = fix.getDouble("lon")
                    accuracy = fix.optDouble("acc", 5.0).toFloat()
                    if (fix.has("speed") && !fix.isNull("speed")) speed = fix.getDouble("speed").toFloat()
                    if (fix.has("bearing") && !fix.isNull("bearing")) bearing = fix.getDouble("bearing").toFloat()
                    altitude = 30.0
                    time = System.currentTimeMillis()
                    elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
                }
                lm.setTestProviderLocation(p, l)
            }
        } catch (t: Throwable) {
            providerReady = false
            status("error", "위치 넣기 실패 ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    // ---- what the SDK says ----

    override fun guidanceDidUpdateSafetyGuide(guidance: KNGuidance, safetyGuide: KNGuide_Safety?) {
        latest = safetyGuide?.safetiesOnGuide.orEmpty().toList()
    }

    override fun guidanceDidUpdateAroundSafeties(guidance: KNGuidance, safeties: List<KNSafety>?) = Unit

    /** The cameras ahead, a second apart at most: for the server's card. */
    override fun guidanceDidUpdateLocation(guidance: KNGuidance, locationGuide: KNGuide_Location) {
        val now = SystemClock.elapsedRealtime()
        if (now - aheadSentAt < 1000) return
        aheadSentAt = now
        val here = locationGuide.location
        val list = JSONArray()
        for (s in latest) {
            if (s.passed) continue
            val d = here?.let { runCatching { it.distToLocation(s.location) }.getOrNull() } ?: continue
            if (d < 0 || d > 1500) continue
            list.put(describe(s, d))
        }
        post("ahead", JSONObject().put("safeties", list))
    }

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
