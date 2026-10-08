package com.melody.player

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Album
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.Timer
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

private data class MusicTrack(
    val uri: Uri,
    val title: String,
    val artist: String,
    val album: String,
    val durationMs: Long,
    val artwork: ByteArray? = null
)

private enum class LibraryTab(val label: String) {
    Home("首页"), Songs("歌曲"), Albums("专辑"), Favorites("收藏")
}

class MainActivity : ComponentActivity() {
    private val library = mutableStateOf<List<MusicTrack>>(emptyList())
    private val controllerState = mutableStateOf<MediaController?>(null)
    private val playbackRevision = mutableIntStateOf(0)
    private val favoriteKeys = mutableStateOf<Set<String>>(emptySet())
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var playerListener: Player.Listener? = null

    private val audioPicker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (!uris.isNullOrEmpty()) importUris(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        connectPlaybackService()
        restoreLibrary()
        favoriteKeys.value = getSharedPreferences("melody-library", Context.MODE_PRIVATE)
            .getStringSet("favorites", emptySet()).orEmpty().toSet()
        setContent {
            MelodyTheme {
                MelodyApp(
                    tracks = library.value,
                    favorites = favoriteKeys.value,
                    player = controllerState.value,
                    playbackRevision = playbackRevision.intValue,
                    onImport = { audioPicker.launch(arrayOf("audio/*")) },
                    onPlayTrack = ::playTrack,
                    onToggleFavorite = ::toggleFavorite,
                    onOpenPlayer = { playbackRevision.intValue++ }
                )
            }
        }
    }

    private fun connectPlaybackService() {
        val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
        val future = MediaController.Builder(this, token).buildAsync()
        controllerFuture = future
        future.addListener({
            runCatching { future.get() }.onSuccess { controller ->
                controllerState.value = controller
                val listener = object : Player.Listener {
                    override fun onEvents(player: Player, events: Player.Events) {
                        playbackRevision.intValue++
                    }
                }
                playerListener = listener
                controller.addListener(listener)
                val existing = library.value
                if (existing.isNotEmpty() && controller.mediaItemCount == 0) {
                    controller.setMediaItems(existing.map(::toMediaItem))
                }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun restoreLibrary() {
        lifecycleScope.launch {
            val saved = withContext(Dispatchers.IO) {
                val values = getSharedPreferences("melody-library", Context.MODE_PRIVATE)
                    .getStringSet("uris", emptySet()).orEmpty().toList()
                values.mapNotNull { raw -> runCatching { readTrack(Uri.parse(raw)) }.getOrNull() }
            }
            library.value = saved
            val controller = controllerState.value
            if (controller != null && controller.mediaItemCount == 0 && saved.isNotEmpty()) {
                controller.setMediaItems(saved.map(::toMediaItem))
            }
        }
    }

    private fun importUris(uris: List<Uri>) {
        lifecycleScope.launch {
            val imported = withContext(Dispatchers.IO) {
                uris.mapNotNull { uri ->
                    runCatching {
                        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    runCatching { readTrack(uri) }.getOrNull()
                }
            }
            if (imported.isEmpty()) return@launch
            val current = library.value.associateBy { it.uri.toString() }.toMutableMap()
            imported.forEach { current[it.uri.toString()] = it }
            val updated = current.values.sortedBy { it.title.lowercase(Locale.getDefault()) }
            library.value = updated
            getSharedPreferences("melody-library", Context.MODE_PRIVATE).edit()
                .putStringSet("uris", updated.map { it.uri.toString() }.toSet()).apply()
            val controller = controllerState.value
            if (controller != null) {
                controller.setMediaItems(updated.map(::toMediaItem))
                controller.prepare()
                val firstImportedIndex = updated.indexOfFirst { track -> imported.any { it.uri == track.uri } }.coerceAtLeast(0)
                controller.seekToDefaultPosition(firstImportedIndex)
                controller.play()
            }
        }
    }

    private fun readTrack(uri: Uri): MusicTrack {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(this, uri)
            val displayName = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            } ?: "未知歌曲"
            val title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE)
                ?.takeIf { it.isNotBlank() } ?: displayName.substringBeforeLast('.', displayName)
            val artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST)
                ?.takeIf { it.isNotBlank() } ?: "未知歌手"
            val album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM)
                ?.takeIf { it.isNotBlank() } ?: "未知专辑"
            val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            MusicTrack(uri, title, artist, album, duration, retriever.embeddedPicture)
        } finally {
            retriever.release()
        }
    }

    private fun toMediaItem(track: MusicTrack): MediaItem {
        val metadata = MediaMetadata.Builder()
            .setTitle(track.title)
            .setArtist(track.artist)
            .setAlbumTitle(track.album)
            .apply { track.artwork?.let { setArtworkData(it, MediaMetadata.PICTURE_TYPE_FRONT_COVER) } }
            .build()
        return MediaItem.Builder().setUri(track.uri).setMediaMetadata(metadata).build()
    }

    private fun playTrack(track: MusicTrack) {
        val player = controllerState.value ?: return
        val tracks = library.value
        val index = tracks.indexOfFirst { it.uri == track.uri }.coerceAtLeast(0)
        player.setMediaItems(tracks.map(::toMediaItem), index, 0L)
        player.prepare()
        player.play()
    }

    private fun toggleFavorite(track: MusicTrack) {
        val key = track.uri.toString()
        favoriteKeys.value = if (key in favoriteKeys.value) favoriteKeys.value - key else favoriteKeys.value + key
        getSharedPreferences("melody-library", Context.MODE_PRIVATE).edit()
            .putStringSet("favorites", favoriteKeys.value).apply()
    }

    override fun onDestroy() {
        playerListener?.let { controllerState.value?.removeListener(it) }
        controllerState.value?.release()
        controllerState.value = null
        controllerFuture?.cancel(false)
        controllerFuture = null
        super.onDestroy()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MelodyApp(
    tracks: List<MusicTrack>,
    favorites: Set<String>,
    player: Player?,
    playbackRevision: Int,
    onImport: () -> Unit,
    onPlayTrack: (MusicTrack) -> Unit,
    onToggleFavorite: (MusicTrack) -> Unit,
    onOpenPlayer: () -> Unit
) {
    var selectedTab by rememberSaveable { mutableStateOf(LibraryTab.Home) }
    var expandedPlayer by rememberSaveable { mutableStateOf(false) }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val currentUri = player?.currentMediaItem?.localConfiguration?.uri
    val currentTrack = tracks.firstOrNull { it.uri == currentUri }
    val visibleTracks = tracks.filter { track ->
        (query.isBlank() || "${track.title} ${track.artist} ${track.album}".contains(query, true))
    }
    val tracksForView = if (selectedTab == LibraryTab.Favorites) {
        visibleTracks.filter { trackKey(it) in favorites }
    } else visibleTracks

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(if (expandedPlayer) "正在播放" else "旋律", fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.4).sp)
                        Text(if (expandedPlayer) "你的此刻，由音乐陪伴" else "你的本地音乐空间", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = {
                    if (expandedPlayer) IconButton(onClick = { expandedPlayer = false }) { Icon(Icons.Default.ArrowBack, contentDescription = "返回") }
                },
                actions = {
                    IconButton(onClick = { searchOpen = !searchOpen; if (!searchOpen) query = "" }) {
                        Icon(Icons.Default.Search, contentDescription = "搜索音乐")
                    }
                    FilledTonalIconButton(onClick = onImport, modifier = Modifier.padding(end = 12.dp)) {
                        Icon(Icons.Default.LibraryMusic, contentDescription = "导入音乐")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background)
            )
        },
        bottomBar = {
            Column {
                if (currentTrack != null && !expandedPlayer) {
                    MiniPlayer(track = currentTrack, player = player, revision = playbackRevision, onToggle = {
                        if (player?.isPlaying == true) player.pause() else player?.play()
                    }, onOpen = { expandedPlayer = true; onOpenPlayer() })
                }
                if (!expandedPlayer) {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        LibraryTab.entries.forEach { tab ->
                            NavigationBarItem(
                                selected = selectedTab == tab,
                                onClick = { selectedTab = tab },
                                icon = { Icon(tabIcon(tab), contentDescription = null) },
                                label = { Text(tab.label) },
                                alwaysShowLabel = true
                            )
                        }
                    }
                }
            }
        }
    ) { innerPadding ->
        if (expandedPlayer && currentTrack != null) {
            FullPlayer(
                track = currentTrack,
                player = player,
                revision = playbackRevision,
                modifier = Modifier.padding(innerPadding),
                onFavorite = { onToggleFavorite(currentTrack) }
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(innerPadding),
                contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 22.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                if (searchOpen) {
                    item { SearchField(value = query, onValueChange = { query = it }) }
                }
                if (selectedTab == LibraryTab.Home) {
                    item { ExpressiveHero(songCount = tracks.size, onImport = onImport) }
                    item { LibraryTiles(tracks = tracks, favorites = favorites.size, onSelect = { selectedTab = it }) }
                    item { SectionTitle("最近加入", "${tracks.size} 首") }
                    if (tracks.isEmpty()) item { EmptyLibrary(onImport) }
                    items(tracks.take(8), key = { it.uri.toString() }) { track ->
                        TrackRow(track, isPlaying = currentUri == track.uri && player?.isPlaying == true, isFavorite = trackKey(track) in favorites, onFavorite = { onToggleFavorite(track) }, onClick = { onPlayTrack(track) })
                    }
                } else if (selectedTab == LibraryTab.Albums) {
                    item { SectionTitle("专辑", "${tracks.map { it.album }.distinct().size} 张") }
                    val grouped = tracks.groupBy { it.album }
                    items(grouped.entries.toList(), key = { it.key }) { (album, albumTracks) ->
                        AlbumRow(album, albumTracks.firstOrNull(), albumTracks.size, onClick = { selectedTab = LibraryTab.Songs; query = album })
                    }
                    if (tracks.isEmpty()) item { EmptyLibrary(onImport) }
                } else {
                    item { SectionTitle(if (selectedTab == LibraryTab.Favorites) "我的最爱" else "全部歌曲", "${tracksForView.size} 首歌曲") }
                    if (selectedTab == LibraryTab.Favorites && tracksForView.isEmpty()) item { EmptyLibrary(onImport, "收藏几首喜欢的歌", "在播放时点亮爱心，这里就会成为你的私人歌单。") }
                    else if (tracksForView.isEmpty()) item { EmptyLibrary(onImport) }
                    items(tracksForView, key = { it.uri.toString() }) { track ->
                        TrackRow(track, isPlaying = currentUri == track.uri && player?.isPlaying == true, isFavorite = trackKey(track) in favorites, onFavorite = { onToggleFavorite(track) }, onClick = { onPlayTrack(track) })
                    }
                }
            }
        }
    }
}

private fun trackKey(track: MusicTrack) = track.uri.toString()

@Composable
private fun tabIcon(tab: LibraryTab) = when (tab) {
    LibraryTab.Home -> Icons.Default.Home
    LibraryTab.Songs -> Icons.Default.QueueMusic
    LibraryTab.Albums -> Icons.Default.Album
    LibraryTab.Favorites -> Icons.Default.FavoriteBorder
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit) {
    androidx.compose.material3.OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = Modifier.fillMaxWidth(),
        leadingIcon = { Icon(Icons.Default.Search, null) },
        placeholder = { Text("搜索歌曲、歌手、专辑") },
        singleLine = true,
        shape = RoundedCornerShape(26.dp)
    )
}

@Composable
private fun ExpressiveHero(songCount: Int, onImport: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().height(190.dp),
        shape = RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp, bottomStart = 14.dp, bottomEnd = 32.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer),
        onClick = onImport
    ) {
        Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.tertiary)))) {
            Row(Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 21.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.Center) {
                    Text("A LITTLE SPACE FOR SOUND", style = MaterialTheme.typography.labelSmall, color = Color.White.copy(alpha = .83f), fontWeight = FontWeight.Bold, letterSpacing = 1.2.sp)
                    Spacer(Modifier.height(9.dp))
                    Text("让喜欢的旋律\n陪你一会儿。", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold, color = Color.White, lineHeight = 30.sp)
                    Spacer(Modifier.height(9.dp))
                    Text("$songCount 首本地歌曲 · 点击导入", style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = .88f))
                }
                VinylIllustration(Modifier.size(112.dp), accent = MaterialTheme.colorScheme.secondaryContainer)
            }
        }
    }
}

@Composable
private fun VinylIllustration(modifier: Modifier = Modifier, accent: Color = MaterialTheme.colorScheme.tertiaryContainer) {
    val turn by animateFloatAsState(targetValue = 0f, label = "vinyl")
    val centerColor = MaterialTheme.colorScheme.primary
    Canvas(modifier.rotate(turn)) {
        val center = androidx.compose.ui.geometry.Offset(size.width / 2, size.height / 2)
        val radius = size.minDimension / 2
        drawCircle(Color(0xFF292443), radius = radius)
        for (ring in 0..5) drawCircle(Color.White.copy(alpha = .08f + ring * .01f), radius = radius * (0.92f - ring * .11f), style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.dp.toPx()))
        drawCircle(accent, radius = radius * .29f)
        drawCircle(centerColor, radius = radius * .09f)
    }
}

@Composable
private fun LibraryTiles(tracks: List<MusicTrack>, favorites: Int, onSelect: (LibraryTab) -> Unit) {
    val entries = listOf(
        Triple("全部歌曲", tracks.size.toString(), Icons.Default.QueueMusic),
        Triple("专辑", tracks.map { it.album }.distinct().size.toString(), Icons.Default.Album),
        Triple("歌手", tracks.map { it.artist }.distinct().size.toString(), Icons.Default.Person),
        Triple("文件夹", "本地", Icons.Default.Folder),
        Triple("我的最爱", favorites.toString(), Icons.Default.FavoriteBorder),
        Triple("播放设置", "音效", Icons.Default.Tune)
    )
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        entries.chunked(2).forEachIndexed { rowIndex, row ->
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                row.forEachIndexed { columnIndex, (label, count, icon) ->
                    val tab = when (label) { "全部歌曲" -> LibraryTab.Songs; "专辑" -> LibraryTab.Albums; "我的最爱" -> LibraryTab.Favorites; else -> LibraryTab.Songs }
                    val accent = when ((rowIndex * 2 + columnIndex) % 3) {
                        0 -> MaterialTheme.colorScheme.primaryContainer
                        1 -> MaterialTheme.colorScheme.secondaryContainer
                        else -> MaterialTheme.colorScheme.tertiaryContainer
                    }
                    Card(
                        modifier = Modifier.weight(1f).height(90.dp),
                        shape = if ((rowIndex + columnIndex) % 2 == 0) RoundedCornerShape(23.dp, 23.dp, 23.dp, 8.dp) else RoundedCornerShape(23.dp, 8.dp, 23.dp, 23.dp),
                        colors = CardDefaults.cardColors(containerColor = accent),
                        onClick = { onSelect(tab) }
                    ) {
                        Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.SpaceBetween) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                                Text(count, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text(label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String, trailing: String) {
    Row(Modifier.fillMaxWidth().padding(top = 2.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.ExtraBold)
        Text(trailing, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyLibrary(onImport: () -> Unit, title: String = "你的音乐库还空空的", subtitle: String = "选择设备里的音乐，打造只属于你的离线音乐空间。") {
    Card(shape = RoundedCornerShape(27.dp, 27.dp, 27.dp, 8.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.fillMaxWidth().padding(21.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(9.dp)) {
            VinylIllustration(Modifier.size(56.dp))
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            androidx.compose.material3.Button(onClick = onImport, shape = RoundedCornerShape(18.dp, 18.dp, 18.dp, 6.dp)) {
                Icon(Icons.Default.LibraryMusic, null, Modifier.size(18.dp)); Spacer(Modifier.width(7.dp)); Text("导入本地音乐")
            }
        }
    }
}

@Composable
private fun TrackRow(track: MusicTrack, isPlaying: Boolean, isFavorite: Boolean, onFavorite: () -> Unit, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().animateContentSize().clickable(onClick = onClick),
        shape = RoundedCornerShape(20.dp, 20.dp, 20.dp, 7.dp),
        colors = CardDefaults.cardColors(containerColor = if (isPlaying) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(track, Modifier.size(47.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text("${track.artist} · ${track.album}", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(formatDuration(track.durationMs), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            IconButton(onClick = onFavorite) { Icon(if (isFavorite) Icons.Default.Favorite else Icons.Default.FavoriteBorder, contentDescription = if (isFavorite) "取消收藏" else "加入收藏", tint = if (isFavorite) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
            IconButton(onClick = onClick) { Icon(if (isPlaying) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "播放 ${track.title}") }
        }
    }
}

@Composable
private fun AlbumRow(album: String, track: MusicTrack?, count: Int, onClick: () -> Unit) {
    if (track == null) return
    Card(modifier = Modifier.fillMaxWidth().clickable(onClick = onClick), shape = RoundedCornerShape(20.dp, 20.dp, 20.dp, 7.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(track, Modifier.size(56.dp))
            Spacer(Modifier.width(13.dp))
            Column(Modifier.weight(1f)) {
                Text(album, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${track.artist} · $count 首歌曲", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Icon(Icons.Default.MoreVert, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun Artwork(track: MusicTrack, modifier: Modifier = Modifier, circular: Boolean = false) {
    val bitmap = remember(track.artwork) {
        track.artwork?.let { bytes -> runCatching { android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() }
    }
    Box(modifier.clip(if (circular) CircleShape else RoundedCornerShape(16.dp, 16.dp, 16.dp, 5.dp)).background(Brush.linearGradient(listOf(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.tertiaryContainer))), contentAlignment = Alignment.Center) {
        if (bitmap != null) Image(bitmap, contentDescription = "${track.album} 封面", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else Icon(Icons.Default.MusicNote, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
    }
}

@Composable
private fun MiniPlayer(track: MusicTrack, player: Player?, revision: Int, onToggle: () -> Unit, onOpen: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 5.dp).clickable(onClick = onOpen),
        shape = RoundedCornerShape(23.dp, 23.dp, 8.dp, 23.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.inverseSurface)
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 11.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Artwork(track, Modifier.size(42.dp))
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(track.title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.inverseOnSurface, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(track.artist, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.inverseOnSurface.copy(alpha = .72f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            IconButton(onClick = { player?.seekToPreviousMediaItem() }) { Icon(Icons.Default.SkipPrevious, contentDescription = "上一首", tint = MaterialTheme.colorScheme.inverseOnSurface) }
            FilledTonalIconButton(onClick = onToggle) { Icon(if (player?.isPlaying == true) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "播放") }
            IconButton(onClick = { player?.seekToNextMediaItem() }) { Icon(Icons.Default.SkipNext, contentDescription = "下一首", tint = MaterialTheme.colorScheme.inverseOnSurface) }
        }
    }
}

@Composable
private fun FullPlayer(track: MusicTrack, player: Player?, revision: Int, modifier: Modifier = Modifier, onFavorite: () -> Unit) {
    var position by remember { mutableStateOf(0L) }
    LaunchedEffect(player, revision) {
        while (true) {
            position = player?.currentPosition ?: 0L
            delay(500)
        }
    }
    Column(modifier.fillMaxSize().padding(horizontal = 23.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Artwork(track, Modifier.size(270.dp), circular = true)
        Spacer(Modifier.height(25.dp))
        Text(track.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.ExtraBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(track.artist, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(track.album, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.outline)
        Spacer(Modifier.height(22.dp))
        Slider(value = if (track.durationMs > 0) position.toFloat().coerceIn(0f, track.durationMs.toFloat()) / track.durationMs else 0f, onValueChange = { player?.seekTo((it * track.durationMs).toLong()) })
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(formatDuration(position), style = MaterialTheme.typography.labelSmall)
            Text(formatDuration(track.durationMs), style = MaterialTheme.typography.labelSmall)
        }
        Spacer(Modifier.height(8.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(15.dp)) {
            IconButton(onClick = { player?.shuffleModeEnabled = !(player?.shuffleModeEnabled ?: false) }) { Icon(Icons.Default.Shuffle, contentDescription = "随机播放") }
            IconButton(onClick = { player?.seekToPreviousMediaItem() }) { Icon(Icons.Default.SkipPrevious, contentDescription = "上一首", modifier = Modifier.size(34.dp)) }
            FilledIconButton(onClick = { if (player?.isPlaying == true) player.pause() else player?.play() }, modifier = Modifier.size(66.dp)) {
                Icon(if (player?.isPlaying == true) Icons.Default.Pause else Icons.Default.PlayArrow, contentDescription = "播放", modifier = Modifier.size(35.dp))
            }
            IconButton(onClick = { player?.seekToNextMediaItem() }) { Icon(Icons.Default.SkipNext, contentDescription = "下一首", modifier = Modifier.size(34.dp)) }
            IconButton(onClick = {
                val current = player?.repeatMode ?: Player.REPEAT_MODE_OFF
                player?.repeatMode = when (current) { Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL; Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE; else -> Player.REPEAT_MODE_OFF }
            }) { Icon(Icons.Default.QueueMusic, contentDescription = "循环模式") }
        }
        Spacer(Modifier.height(12.dp))
        FilledTonalIconButton(onClick = onFavorite) { Icon(Icons.Default.FavoriteBorder, contentDescription = "收藏") }
    }
}

private fun formatDuration(milliseconds: Long): String {
    if (milliseconds <= 0L) return "--:--"
    val seconds = milliseconds / 1000
    return "%02d:%02d".format(seconds / 60, seconds % 60)
}
