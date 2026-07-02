import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { AudioManager } from './audio.js';

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
);

camera.position.z = 3;

const renderer = new THREE.WebGLRenderer({
    antialias: true
});

function latLonToVector3(lat, lon, radius = 1) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lon + 180) * Math.PI / 180;

    return new THREE.Vector3(
        -radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
    );
}

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(5, 3, 5);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x404040, 1));

const geometry = new THREE.SphereGeometry(1, 64, 64);
const loader = new THREE.TextureLoader();
const texture = loader.load('/earth.jpg');
const material = new THREE.MeshStandardMaterial({ map: texture });
const earth = new THREE.Mesh(geometry, material);
scene.add(earth);

function createSpectrogramMarker(position) {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;

    const context = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        color: 0xffffff
    });

    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.08, 0.08, 1);
    sprite.position.copy(position.clone().multiplyScalar(1.01));

    const marker = {
        sprite,
        canvas,
        context,
        texture
    };

    drawSpectrogramMarker(marker, new Uint8Array(16));

    return marker;
}

function drawSpectrogramMarker(marker, frequencyData) {
    const { canvas, context, texture } = marker;
    const width = canvas.width;
    const height = canvas.height;

    context.clearRect(0, 0, width, height);

    const glow = context.createRadialGradient(width * 0.5, height * 0.5, 0, width * 0.5, height * 0.5, width * 0.5);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);

    const barCount = 10;
    const barWidth = (width - 10) / barCount;
    const maxHeight = height - 12;
    const baseY = height - 4;

    for (let index = 0; index < barCount; index += 1) {
        const sampleIndex = Math.min(frequencyData.length - 1, Math.floor((index / barCount) * (frequencyData.length - 1)));
        const value = frequencyData[sampleIndex] / 255;
        const barHeight = 4 + Math.max(2, value * maxHeight);
        const x = 4 + index * barWidth;
        const y = baseY - barHeight;
        const alpha = 0.2 + value * 0.85;
        const hue = 190 + value * 45;

        context.fillStyle = `hsla(${hue}, 90%, 65%, ${alpha})`;
        context.fillRect(x, y, Math.max(2, barWidth - 2), barHeight);
    }

    const scan = (performance.now() * 0.001 * height * 0.8) % (height + 12) - 12;
    context.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(0, scan);
    context.lineTo(width, scan + 4);
    context.stroke();

    texture.needsUpdate = true;
}

let controls;
let audioEntries = [];
let audioLoaded = false;
let audioEnabled = false;
let zoomHintVisible = false;
let zoomHintDismissed = false;
let initialCameraDistance = camera.position.length();
let shouldSpin = true;
let detailActive = false;
let activeEntry = null;
let markers = [];
const raycaster = new THREE.Raycaster();
raycaster.params.Sprite.threshold = 0.03;
const mouse = new THREE.Vector2();
const pointerState = {
    downX: 0,
    downY: 0,
    moved: false
};
const audio = new AudioManager();

function createZoomHint() {
    const style = document.createElement('style');
    style.textContent = `
        .zoom-hint {
            position: fixed;
            left: 50%;
            bottom: 86px;
            transform: translateX(-50%) translateY(8px);
            padding: 9px 13px;
            border-radius: 999px;
            background: rgba(10, 15, 20, 0.76);
            color: rgba(247, 239, 230, 0.94);
            font-size: 12px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            backdrop-filter: blur(8px);
            box-shadow: 0 10px 24px rgba(0, 0, 0, 0.2);
            opacity: 0;
            pointer-events: none;
            transition: opacity 180ms ease, transform 180ms ease;
            z-index: 1000;
        }
        .zoom-hint.is-visible {
            opacity: 1;
            transform: translateX(-50%) translateY(0);
        }
    `;
    document.head.appendChild(style);

    const hint = document.createElement('div');
    hint.className = 'zoom-hint';
    hint.textContent = 'scroll to zoom';
    document.body.appendChild(hint);
    return hint;
}

const zoomHint = createZoomHint();

function updateZoomHint() {
    if (audioEnabled && !zoomHintDismissed) {
        zoomHint.classList.add('is-visible');
    } else {
        zoomHint.classList.remove('is-visible');
    }
}

function handleControlsChange() {
    if (!controls) {
        return;
    }

    if (shouldSpin) {
        shouldSpin = false;
    }

    if (!audioEnabled || zoomHintDismissed) {
        return;
    }

    if (Math.abs(controls.getDistance() - initialCameraDistance) > 0.001) {
        zoomHintDismissed = true;
        updateZoomHint();
    }
}

function createAudioToggleButton() {
    const style = document.createElement('style');
    style.textContent = `
        .audio-toggle {
            position: fixed;
            right: 24px;
            bottom: 24px;
            width: 54px;
            height: 54px;
            border: 0;
            border-radius: 999px;
            display: grid;
            place-items: center;
            cursor: pointer;
            z-index: 1000;
            color: #f7efe6;
            background: rgba(12, 18, 26, 0.78);
            backdrop-filter: blur(8px);
            box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
            opacity: 0.72;
            transform: translateZ(0);
            transition: transform 180ms ease, opacity 180ms ease, background 180ms ease;
            animation: audio-toggle-fade 3s ease-in-out infinite;
        }
        .audio-toggle:hover {
            transform: scale(1.04);
            opacity: 0.95;
        }
        .audio-toggle:active {
            transform: scale(0.95);
        }
        .audio-toggle.is-enabled {
            background: rgba(35, 96, 160, 0.94);
            opacity: 1;
            animation: none;
        }
        .audio-toggle svg {
            width: 24px;
            height: 24px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.8;
            stroke-linecap: round;
            stroke-linejoin: round;
            pointer-events: none;
        }
        @keyframes audio-toggle-fade {
            0%, 100% { opacity: 0.65; transform: scale(0.98); }
            50% { opacity: 0.95; transform: scale(1.03); }
        }
    `;
    document.head.appendChild(style);

    const button = document.createElement('button');
    button.className = 'audio-toggle';
    button.type = 'button';
    button.setAttribute('aria-label', 'Enable audio');
    button.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4Z"></path>
            <path d="M16 8a6 6 0 0 1 0 8"></path>
            <path d="M18.5 5.5a10 10 0 0 1 0 13"></path>
            <path d="M4 4 20 20"></path>
        </svg>
    `;
    button.addEventListener('click', () => {
        void startAudio();
    });
    document.body.appendChild(button);
    return button;
}

function createDetailOverlay() {
    const style = document.createElement('style');
    style.textContent = `
        .detail-overlay {
            position: fixed;
            inset: 0;
            pointer-events: none;
            opacity: 0;
            transition: opacity 260ms ease;
            z-index: 900;
        }
        .detail-overlay.visible {
            opacity: 1;
            pointer-events: auto;
        }
        .detail-panel {
            position: fixed;
            top: 24px;
            left: 24px;
            right: 24px;
            max-width: calc(100vw - 48px);
            display: flex;
            gap: 18px;
            align-items: flex-start;
            justify-content: flex-start;
            pointer-events: auto;
            opacity: 0;
            transform: translateY(-16px);
            transition: opacity 260ms ease, transform 260ms ease;
        }
        .detail-panel.visible {
            opacity: 1;
            transform: translateY(0);
        }
        .detail-map {
            width: min(360px, 42vw);
            aspect-ratio: 16 / 10;
            border-radius: 18px;
            overflow: hidden;
            box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35);
            background: radial-gradient(circle at top left, rgba(28, 146, 255, 0.2), transparent 38%), rgba(7, 14, 24, 0.95);
        }
        .detail-meta {
            flex: 1 1 320px;
            min-width: 260px;
            padding: 22px;
            border-radius: 18px;
            background: rgba(8, 12, 18, 0.92);
            backdrop-filter: blur(18px);
            color: #f4f0ea;
            box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
            display: flex;
            flex-direction: column;
            gap: 12px;
            font-family: sans-serif;
        }
        .detail-meta h2 {
            margin: 0;
            font-size: 1.1rem;
            letter-spacing: 0.02em;
        }
        .detail-meta p {
            margin: 0;
            line-height: 1.5;
            color: rgba(244, 240, 234, 0.86);
        }
        .detail-meta .detail-field {
            opacity: 0.82;
            font-size: 0.95rem;
        }
        .detail-close {
            margin-top: auto;
            align-self: flex-start;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 999px;
            padding: 10px 16px;
            background: rgba(255, 255, 255, 0.05);
            color: #f7efe6;
            cursor: pointer;
            transition: background 150ms ease, transform 150ms ease;
        }
        .detail-close:hover {
            background: rgba(255, 255, 255, 0.11);
            transform: translateY(-1px);
        }
        .renderer-mini {
            position: fixed !important;
            top: 20px !important;
            left: 20px !important;
            width: min(360px, 42vw) !important;
            height: auto !important;
            max-height: min(240px, 28vh) !important;
            border-radius: 18px;
            box-shadow: 0 28px 90px rgba(0, 0, 0, 0.42);
            transition: transform 260ms ease, width 260ms ease, height 260ms ease, top 260ms ease, left 260ms ease, box-shadow 260ms ease;
            z-index: 850;
        }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'detail-overlay';

    const panel = document.createElement('div');
    panel.className = 'detail-panel';

    const mapWrapper = document.createElement('div');
    mapWrapper.className = 'detail-map';

    const mapCanvas = document.createElement('canvas');
    mapCanvas.width = 480;
    mapCanvas.height = 300;
    mapCanvas.style.width = '100%';
    mapCanvas.style.height = '100%';
    mapWrapper.appendChild(mapCanvas);

    const meta = document.createElement('div');
    meta.className = 'detail-meta';
    meta.innerHTML = `
        <div>
            <div class="detail-label">Selected audio location</div>
            <h2 id="detail-title">Loading…</h2>
        </div>
        <div id="detail-description"></div>
        <p class="detail-field" id="detail-coordinate"></p>
        <p class="detail-field" id="detail-file"></p>
        <button class="detail-close" type="button">Close detail view</button>
    `;

    panel.appendChild(mapWrapper);
    panel.appendChild(meta);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    return {
        overlay,
        panel,
        mapCanvas,
        detailTitle: meta.querySelector('#detail-title'),
        detailDescription: meta.querySelector('#detail-description'),
        detailCoordinate: meta.querySelector('#detail-coordinate'),
        detailFile: meta.querySelector('#detail-file'),
        closeButton: meta.querySelector('.detail-close')
    };
}

function tileXYFromLatLon(lat, lon, zoom) {
    const latRad = lat * Math.PI / 180;
    const n = Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * n;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
}

function loadTileImage(url) {
    return new Promise((resolve) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

async function drawDetailMap(canvas, lat, lon) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const zoom = 4;
    const tileSize = 256;
    const center = tileXYFromLatLon(lat, lon, zoom);
    const pixelX = center.x * tileSize;
    const pixelY = center.y * tileSize;

    const tileLeft = Math.floor((pixelX - width / 2) / tileSize);
    const tileTop = Math.floor((pixelY - height / 2) / tileSize);
    const offsetX = Math.round((tileLeft * tileSize) - (pixelX - width / 2));
    const offsetY = Math.round((tileTop * tileSize) - (pixelY - height / 2));

    const columns = Math.ceil(width / tileSize) + 1;
    const rows = Math.ceil(height / tileSize) + 1;

    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
            const x = tileLeft + col;
            const y = tileTop + row;
            const wrappedX = ((x % (1 << zoom)) + (1 << zoom)) % (1 << zoom);
            const wrappedY = ((y % (1 << zoom)) + (1 << zoom)) % (1 << zoom);
            const url = `https://a.tile.openstreetmap.org/${zoom}/${wrappedX}/${wrappedY}.png`;
            const image = await loadTileImage(url);
            if (image) {
                ctx.drawImage(image, offsetX + col * tileSize, offsetY + row * tileSize, tileSize, tileSize);
            } else {
                ctx.fillStyle = '#07101a';
                ctx.fillRect(offsetX + col * tileSize, offsetY + row * tileSize, tileSize, tileSize);
            }
        }
    }

    const centerX = width / 2;
    const centerY = height / 2;
    ctx.beginPath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.arc(centerX, centerY, 18, 0, Math.PI * 2);
    ctx.fill();

    const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 18 * pulse, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(94, 214, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#5ee0ff';
    ctx.fill();

    return canvas;
}

function formatEntryMetadata(entry) {
    const title = entry.common_name || entry.species || 'Wildlife sound';
    const description = entry.location || entry.comment || 'No additional description available.';
    const file = entry.path || `/audio/${entry.filename}`;
    return { title, description, file };
}

function showDetailForMarker(entry, lat, lon) {
    activeEntry = entry;
    detailActive = true;
    controls.enabled = false;
    renderer.domElement.classList.add('renderer-mini');
    detailUI.overlay.classList.add('visible');
    detailUI.panel.classList.add('visible');

    const meta = formatEntryMetadata(entry);
    detailUI.detailTitle.textContent = meta.title;
    detailUI.detailDescription.textContent = meta.description;
    detailUI.detailCoordinate.textContent = `Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}`;
    detailUI.detailFile.textContent = `File: ${meta.file}`;
    drawDetailMap(detailUI.mapCanvas, lat, lon);
}

function hideDetailView() {
    detailActive = false;
    activeEntry = null;
    controls.enabled = true;
    renderer.domElement.classList.remove('renderer-mini');
    detailUI.overlay.classList.remove('visible');
    detailUI.panel.classList.remove('visible');
}

function handlePointerDown(event) {
    pointerState.downX = event.clientX;
    pointerState.downY = event.clientY;
    pointerState.moved = false;
}

function handlePointerMove(event) {
    const dx = event.clientX - pointerState.downX;
    const dy = event.clientY - pointerState.downY;
    pointerState.moved = pointerState.moved || Math.hypot(dx, dy) > 4;
}

function handleCanvasClick(event) {
    if (detailActive || pointerState.moved) {
        return;
    }

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);

    const hit = raycaster.intersectObjects(markers.map((marker) => marker.sprite));
    if (hit.length > 0) {
        const sprite = hit[0].object;
        const { entry, lat, lon } = sprite.userData;
        showDetailForMarker(entry, lat, lon);
    }
}

const audioToggleButton = createAudioToggleButton();
const detailUI = createDetailOverlay();

function updateAudioToggleButton() {
    audioToggleButton.classList.toggle('is-enabled', audioEnabled);
    audioToggleButton.setAttribute('aria-label', audioEnabled ? 'Audio enabled' : 'Enable audio');
    audioToggleButton.innerHTML = audioEnabled
        ? `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M11 5 6 9H3v6h3l5 4Z"></path>
                <path d="M16 8a6 6 0 0 1 0 8"></path>
                <path d="M18.5 5.5a10 10 0 0 1 0 13"></path>
            </svg>
        `
        : `
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M11 5 6 9H3v6h3l5 4Z"></path>
                <path d="M16 8a6 6 0 0 1 0 8"></path>
                <path d="M18.5 5.5a10 10 0 0 1 0 13"></path>
                <path d="M4 4 20 20"></path>
            </svg>
        `;
}

updateAudioToggleButton();

async function loadAudioEntries() {
    if (audioEntries.length === 0) {
        try {
            const manifestResponse = await fetch('/audio/manifest.json');
            if (manifestResponse.ok) {
                const manifest = await manifestResponse.json();
                audioEntries = Array.isArray(manifest.entries) ? manifest.entries : [];
            }
        } catch (error) {
            console.warn('Unable to load audio manifest:', error);
        }
    }

    if (audioEntries.length === 0) {
        console.warn('No audio entries were found. Run npm run fetch-audio first.');
        return;
    }

    for (const [index, entry] of audioEntries.slice(0, 100).entries()) {
        const latitude = Number.isFinite(entry.latitude) ? entry.latitude : undefined;
        const longitude = Number.isFinite(entry.longitude) ? entry.longitude : undefined;

        const lat = latitude ?? ((index % 10) - 5) * 12;
        const lon = longitude ?? (((index * 37) % 360) - 180);
        const position = latLonToVector3(lat, lon);

        const marker = createSpectrogramMarker(position);
        marker.sprite.userData = {
            entry,
            lat,
            lon
        };
        markers.push(marker);
        earth.add(marker.sprite);

        await audio.addSound({
            species: entry.common_name || entry.species || 'Wildlife',
            file: entry.path || `/audio/${entry.filename}`,
            position,
            earth,
            entry,
            onAnalyserData: (frequencyData) => drawSpectrogramMarker(marker, frequencyData)
        });
    }
}

async function startAudio() {
    if (audioEnabled) {
        return;
    }

    try {
        await audio.start();
        audioEnabled = true;
        zoomHintDismissed = false;
        updateAudioToggleButton();
        updateZoomHint();
        if (!audioLoaded) {
            await loadAudioEntries();
            audioLoaded = true;
        }
    } catch (error) {
        console.error('Unable to start audio', error);
        audioEnabled = false;
        updateAudioToggleButton();
    }
}

renderer.domElement.addEventListener('pointerdown', handlePointerDown);
renderer.domElement.addEventListener('pointermove', handlePointerMove);
renderer.domElement.addEventListener('click', handleCanvasClick);
detailUI.closeButton.addEventListener('click', hideDetailView);

function animate() {
    requestAnimationFrame(animate);

    if (controls) {
        controls.update();
    }

    if (shouldSpin) {
        earth.rotation.y += 0.002;
    }
    renderer.render(scene, camera);

    if (audioEnabled) {
        audio.updateListener(camera);
        audio.updateVolumes(camera, earth, activeEntry);
        audio.update();
    }
}

controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enablePan = false;
controls.minDistance = 1.3;
controls.maxDistance = 10;
controls.addEventListener('start', () => {
    shouldSpin = false;
});
controls.addEventListener('change', handleControlsChange);

updateZoomHint();
animate();