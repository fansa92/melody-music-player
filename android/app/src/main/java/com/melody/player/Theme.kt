package com.melody.player

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val ExpressiveLight = lightColorScheme(
    primary = Color(0xFF5146B8),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE5E1FF),
    onPrimaryContainer = Color(0xFF21195A),
    secondary = Color(0xFF80546D),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFD8EA),
    onSecondaryContainer = Color(0xFF351327),
    tertiary = Color(0xFF006B62),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFAAF2E7),
    onTertiaryContainer = Color(0xFF00201C),
    background = Color(0xFFF8F6FC),
    onBackground = Color(0xFF1B1B22),
    surface = Color(0xFFF8F6FC),
    onSurface = Color(0xFF1B1B22),
    surfaceVariant = Color(0xFFE9E6EF),
    onSurfaceVariant = Color(0xFF494650),
    outline = Color(0xFF777580),
    outlineVariant = Color(0xFFD0CDD8)
)

private val ExpressiveDark = darkColorScheme(
    primary = Color(0xFFC5BEFF),
    onPrimary = Color(0xFF2C237D),
    primaryContainer = Color(0xFF40379A),
    onPrimaryContainer = Color(0xFFE5E1FF),
    secondary = Color(0xFFF0B8D0),
    onSecondary = Color(0xFF4B263C),
    secondaryContainer = Color(0xFF633C52),
    onSecondaryContainer = Color(0xFFFFD8EA),
    tertiary = Color(0xFF87D5C8),
    onTertiary = Color(0xFF003731),
    tertiaryContainer = Color(0xFF005048),
    onTertiaryContainer = Color(0xFFAAF2E7),
    background = Color(0xFF14131A),
    onBackground = Color(0xFFE7E1EF),
    surface = Color(0xFF14131A),
    onSurface = Color(0xFFE7E1EF),
    surfaceVariant = Color(0xFF302E38),
    onSurfaceVariant = Color(0xFFCAC5D3),
    outline = Color(0xFF938E9C),
    outlineVariant = Color(0xFF494650)
)

private val ExpressiveShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(20.dp),
    large = RoundedCornerShape(28.dp),
    extraLarge = RoundedCornerShape(34.dp)
)

private val ExpressiveTypography = Typography().let { type ->
    type.copy(
        displaySmall = type.displaySmall.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = (-1.2).sp),
        headlineLarge = type.headlineLarge.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.8).sp),
        headlineMedium = type.headlineMedium.copy(fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp),
        titleLarge = type.titleLarge.copy(fontWeight = FontWeight.Bold),
        titleMedium = type.titleMedium.copy(fontWeight = FontWeight.SemiBold)
    )
}

@Composable
fun MelodyTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val dark = isSystemInDarkTheme()
    val scheme = when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> dynamicLightColorScheme(context)
        dark -> ExpressiveDark
        else -> ExpressiveLight
    }
    MaterialTheme(colorScheme = scheme, typography = ExpressiveTypography, shapes = ExpressiveShapes, content = content)
}
