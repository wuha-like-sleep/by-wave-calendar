// ScannerScreen — CameraX + ML Kit barcode scanner. Mirrors iOS
// ScannerView.swift. The QR code's payload from the server is a pair
// URL of the form `bywave://pair?...&token=...&server=...&email=...`.
// We hand the raw string back to SetupScreen which decodes it.
//
// Visual: full-screen camera preview + dim overlay with a centered
// square cutout + L-shaped corner brackets + a moving accent-colored
// scan line. Tap × to cancel.

package cn.bywave.calendar.ui.setup

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import cn.bywave.calendar.R
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

@Composable
fun ScannerScreen(
    onResult: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var permissionGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> permissionGranted = granted }

    // Request permission on first composition if not yet granted.
    LaunchedEffect(Unit) {
        if (!permissionGranted) launcher.launch(Manifest.permission.CAMERA)
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (permissionGranted) {
            CameraPreview(onResult = onResult)
            ViewfinderOverlay()
        } else {
            PermissionPrompt(
                onRequest = { launcher.launch(Manifest.permission.CAMERA) },
            )
        }

        // Close button (always on top)
        IconButton(
            onClick = onCancel,
            modifier = Modifier.padding(8.dp),
        ) {
            Icon(
                Icons.Default.Close,
                contentDescription = stringResource(R.string.scanner_cancel),
                tint = Color.White.copy(alpha = 0.95f),
                modifier = Modifier.size(28.dp),
            )
        }

        // Hint pill
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 60.dp)
                .clip(RoundedCornerShape(percent = 50))
                .background(Color.Black.copy(alpha = 0.5f))
                .padding(horizontal = 14.dp, vertical = 8.dp),
        ) {
            Text(
                text = stringResource(R.string.scan_hint),
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun PermissionPrompt(onRequest: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(32.dp),
        ) {
            Text(
                text = stringResource(R.string.scan_no_camera_permission),
                color = Color.White,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.scanner_camera_permission_steps),
                color = Color.White.copy(alpha = 0.7f),
                style = MaterialTheme.typography.bodySmall,
            )
            Button(onClick = onRequest) {
                Text(stringResource(R.string.scan_grant_permission))
            }
        }
    }
}

@Composable
private fun CameraPreview(onResult: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val cameraExecutor = remember { Executors.newSingleThreadExecutor() }
    val barcodeScanner = remember {
        BarcodeScanning.getClient(
            com.google.mlkit.vision.barcode.BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build(),
        )
    }
    var hasFired by remember { mutableStateOf(false) }

    DisposableEffect(Unit) {
        onDispose {
            cameraExecutor.shutdown()
            barcodeScanner.close()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }
            val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
            cameraProviderFuture.addListener({
                val cameraProvider = cameraProviderFuture.get()

                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }

                val analyzer = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build().also { ia ->
                        ia.setAnalyzer(cameraExecutor) { imageProxy ->
                            if (hasFired) {
                                imageProxy.close()
                                return@setAnalyzer
                            }
                            val mediaImage = imageProxy.image ?: run {
                                imageProxy.close(); return@setAnalyzer
                            }
                            val image = InputImage.fromMediaImage(
                                mediaImage,
                                imageProxy.imageInfo.rotationDegrees,
                            )
                            barcodeScanner.process(image)
                                .addOnSuccessListener { barcodes ->
                                    barcodes.firstOrNull()?.rawValue?.let { raw ->
                                        if (!hasFired) {
                                            hasFired = true
                                            onResult(raw)
                                        }
                                    }
                                }
                                .addOnCompleteListener { imageProxy.close() }
                        }
                    }

                runCatching {
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analyzer,
                    )
                }
            }, ContextCompat.getMainExecutor(ctx))
            previewView
        },
    )
}

@Composable
private fun ViewfinderOverlay() {
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val side = minOf(maxWidth, maxHeight) * 0.70f
        val sideMargin = (maxWidth - side) / 2
        val topMargin = (maxHeight - side) / 2

        // 4 dark rectangles forming a hole
        Column(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.fillMaxWidth().height(topMargin).background(Color.Black.copy(alpha = 0.5f)))
            Row(modifier = Modifier.fillMaxWidth().height(side)) {
                Box(modifier = Modifier.width(sideMargin).fillMaxHeight().background(Color.Black.copy(alpha = 0.5f)))
                Spacer(modifier = Modifier.width(side))
                Box(modifier = Modifier.width(sideMargin).fillMaxHeight().background(Color.Black.copy(alpha = 0.5f)))
            }
            Box(modifier = Modifier.fillMaxWidth().height(topMargin).background(Color.Black.copy(alpha = 0.5f)))
        }

        // Outline + corner brackets
        val brand = MaterialTheme.colorScheme.primary
        Box(
            modifier = Modifier
                .offset(x = sideMargin, y = topMargin)
                .size(side)
                .clip(RoundedCornerShape(12.dp)),
        ) {
            // Subtle outline
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Transparent),
            )
            // 4 corner brackets
            val arm = 26.dp
            val thick = 4.dp
            // top-left
            Box(modifier = Modifier.offset(0.dp, 0.dp).size(width = arm, height = thick).background(Color.White))
            Box(modifier = Modifier.offset(0.dp, 0.dp).size(width = thick, height = arm).background(Color.White))
            // top-right
            Box(modifier = Modifier.align(Alignment.TopEnd).size(width = arm, height = thick).background(Color.White))
            Box(modifier = Modifier.align(Alignment.TopEnd).size(width = thick, height = arm).background(Color.White))
            // bottom-left
            Box(modifier = Modifier.align(Alignment.BottomStart).size(width = arm, height = thick).background(Color.White))
            Box(modifier = Modifier.align(Alignment.BottomStart).size(width = thick, height = arm).background(Color.White))
            // bottom-right
            Box(modifier = Modifier.align(Alignment.BottomEnd).size(width = arm, height = thick).background(Color.White))
            Box(modifier = Modifier.align(Alignment.BottomEnd).size(width = thick, height = arm).background(Color.White))

            // Animated scan line
            val transition = rememberInfiniteTransition(label = "scan")
            val phase by transition.animateFloat(
                initialValue = 0f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(durationMillis = 1800),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "scanPhase",
            )
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(2.dp)
                    .offset(y = (side - 16.dp) * phase + 8.dp)
                    .padding(horizontal = 8.dp)
                    .clip(RoundedCornerShape(1.dp))
                    .background(brand.copy(alpha = 0.85f)),
            )
        }
    }
}

