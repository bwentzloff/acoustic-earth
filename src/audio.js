import * as THREE from 'three';

export class AudioManager {

    constructor() {

        this.context = null;

        this.listener = null;

        this.sounds = [];

        this.raycaster = new THREE.Raycaster();

    }

    async start() {

        if (!this.context) {
            this.context = new AudioContext();
            this.listener = this.context.listener;
        }

        if (this.context.state !== 'running') {
            await this.context.resume();
        }

    }

    ensureContext() {

        if (!this.context) {
            throw new Error('Audio context has not been started yet.');
        }

        return this.context;

    }

    async loadBuffer(url) {

        const context = this.ensureContext();

        const response = await fetch(url);

        const arrayBuffer = await response.arrayBuffer();

        return await context.decodeAudioData(arrayBuffer);

    }

    async addSound(options) {

        const context = this.ensureContext();
        const buffer = await this.loadBuffer(options.file);

        const source = context.createBufferSource();

        source.buffer = buffer;
        source.loop = true;

        const gain = context.createGain();
        gain.gain.value = 0;

        const analyser = context.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.88;

        const panner = context.createPanner();

        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';

        panner.refDistance = 0.5;
        panner.maxDistance = 20;

        panner.rolloffFactor = 1;

        source.connect(gain);
        gain.connect(analyser);
        analyser.connect(panner);
        panner.connect(context.destination);

        source.start();

        const sound = {

            species: options.species,

            position: options.position.clone(),

            earth: options.earth || null,

            entry: options.entry || null,

            gain,

            analyser,

            frequencyData: new Uint8Array(analyser.frequencyBinCount),

            panner,

            source,

            onAnalyserData: options.onAnalyserData || null,

            targetVolume: 0

        };

        this.sounds.push(sound);

        return sound;

    }

    updateListener(camera) {

        if (!this.listener || !camera) {
            return;
        }

        this.listener.positionX.value = camera.position.x;
        this.listener.positionY.value = camera.position.y;
        this.listener.positionZ.value = camera.position.z;

    }

    update() {

        if (!this.context) {
            return;
        }

        for (const sound of this.sounds) {

            sound.panner.positionX.value = sound.position.x;
            sound.panner.positionY.value = sound.position.y;
            sound.panner.positionZ.value = sound.position.z;

            if (sound.analyser) {
                sound.analyser.getByteFrequencyData(sound.frequencyData);
                if (sound.onAnalyserData) {
                    sound.onAnalyserData(sound.frequencyData);
                }
            }

            sound.gain.gain.linearRampToValueAtTime(

                sound.targetVolume,

                this.context.currentTime + 0.15

            );

        }

    }

    updateVolumes(camera, earth, selectedEntry = null) {

        if (!this.context) {
            return;
        }

        for (const sound of this.sounds) {

            let volume = 0;

            if (selectedEntry && sound.entry !== selectedEntry) {
                sound.targetVolume = 0;
                continue;
            }

            const distance = camera.position.distanceTo(sound.position);
            const projected = sound.position.clone().project(camera);
            const isInFrustum = projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1 && projected.z >= 0 && projected.z <= 1;

            const maxAudibleDistance = 12;
            if (isInFrustum && (earth || sound.earth)) {
                const targetEarth = earth || sound.earth;
                const direction = sound.position.clone().sub(camera.position).normalize();
                this.raycaster.set(camera.position, direction);
                const intersections = this.raycaster.intersectObject(targetEarth, false);
                const markerDistance = camera.position.distanceTo(sound.position);
                const isVisible = intersections.length === 0 || intersections[0].distance >= markerDistance - 0.01;

                if (isVisible) {
                    volume = 1 - distance / maxAudibleDistance;
                }
            } else if (isInFrustum) {
                volume = 1 - distance / maxAudibleDistance;
            }

            volume = Math.max(0, Math.min(1, volume));

            sound.targetVolume = volume;

        }

    }

}