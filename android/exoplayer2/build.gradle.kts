// Google's ExoPlayer 2.16+ by default; CI also compiles against the oldest (-Pexoplayer2=2.16.1)
// and Amazon's port (-Pexoplayer2=amazon).
val exoplayer2 = providers.gradleProperty("exoplayer2").orNull
dependencies {
    compileOnly(
        when (exoplayer2) {
            null -> "com.google.android.exoplayer:exoplayer-core:2.19.1"
            "amazon" -> "com.amazon.android:exoplayer-core:2.18.7"
            else -> "com.google.android.exoplayer:exoplayer-core:$exoplayer2"
        },
    )
}
