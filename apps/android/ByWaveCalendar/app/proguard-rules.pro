# Project-specific ProGuard / R8 rules.
#
# Keep until v0.1 ships and we measure APK size. Currently R8 is off
# (isMinifyEnabled = false). When we turn it on, these rules guarantee:
#   1. Kotlinx Serialization @Serializable classes stay intact
#   2. Retrofit method-level annotations work via reflection
#   3. Room generated DAO/Database classes don't get renamed

# Kotlinx Serialization — keep @Serializable classes + their companion
# objects so the generated serializer() can be found at runtime.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault
-keep,includedescriptorclasses class cn.bywave.calendar.**$$serializer { *; }
-keepclassmembers class cn.bywave.calendar.** {
    *** Companion;
}
-keepclasseswithmembers class cn.bywave.calendar.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# Retrofit — interface methods use annotations parsed at runtime.
-keepattributes Signature, Exceptions
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class retrofit2.Response

# OkHttp logging interceptor uses Conscrypt if available; safe to ignore.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
