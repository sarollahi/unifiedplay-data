// Any Media3 1.x: CI also compiles against the oldest (-Pmedia3=1.0.0).
val media3 = providers.gradleProperty("media3").getOrElse("1.11.0")
dependencies { compileOnly("androidx.media3:media3-exoplayer:$media3") }
