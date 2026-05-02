// =============================================================================
// apps/mobile/src/features/photo/usePhotoCapture.tsx
// =============================================================================
// Capture a photo on mobile, attach GPS, persist to durable storage, and
// enqueue into photo_queue. The sync engine uploads it on the next run.
//
// Required deps:
//   expo install expo-camera expo-location expo-file-system expo-media-library
//
// Permissions in app.json:
//   {
//     "expo": {
//       "plugins": [
//         ["expo-camera",  { "cameraPermission": "Capture activity photos in the field" }],
//         ["expo-location",{ "locationAlwaysAndWhenInUsePermission": "Tag photos with farm location" }]
//       ]
//     }
//   }
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import * as FileSystem from 'expo-file-system';
import * as Location from 'expo-location';

import { database, getEngine, PhotoQueueRow } from '../../sync';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CapturedPhoto {
  /** Final persistent file:// URI after moving out of the cache dir. */
  uri: string;
  /** UUID this photo is attached to in photo_queue. */
  clientId: string;
  /** Bytes — useful for UI feedback on slow networks. */
  size: number;
  width: number;
  height: number;
  takenAt: Date;
  geom: { lat: number; lon: number; accuracy_m?: number } | null;
}

export interface CaptureOptions {
  /** Which table the photo attaches to. Must match a parent_table in photo_queue. */
  parentTable: 'crop_activity' | 'harvest' | 'qc_test';
  /** client_id of the parent row (the one queued via Queue.enqueue). */
  parentClientId: string;
  /** JPEG quality 0..1. Defaults to 0.7 — already a good size/quality tradeoff. */
  quality?: number;
  /** When true, also strip EXIF before uploading (privacy). Default: keep it. */
  stripExif?: boolean;
}

export interface UsePhotoCaptureApi {
  /** Capture and queue. Returns immediately after the file is persisted. */
  capture: (camera: CameraView, opts: CaptureOptions) => Promise<CapturedPhoto>;
  /** Permission status helpers. */
  cameraPermission: ReturnType<typeof useCameraPermissions>[0];
  requestCameraPermission: ReturnType<typeof useCameraPermissions>[1];
  locationPermission: 'granted' | 'denied' | 'unknown';
  requestLocationPermission: () => Promise<'granted' | 'denied'>;
  /** Whether at least one permission is still missing. */
  isReady: boolean;
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export function usePhotoCapture(): UsePhotoCaptureApi {
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [locPerm, setLocPerm] = useState<'granted' | 'denied' | 'unknown'>('unknown');

  // Last known location, refreshed every ~30s. We don't wait for a fix during
  // capture because that's a 1-3 s latency hit on cold start.
  const lastFixRef = useRef<Location.LocationObject | null>(null);

  useEffect(() => {
    Location.getForegroundPermissionsAsync().then((p) => {
      setLocPerm(p.granted ? 'granted' : p.canAskAgain ? 'unknown' : 'denied');
    });
  }, []);

  // Keep a warm GPS fix while the camera screen is open. Caller is responsible
  // for unmounting the screen when not capturing — see CameraScreen below.
  useEffect(() => {
    if (locPerm !== 'granted') return;
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 15_000,
          distanceInterval: 10,
        },
        (loc) => { lastFixRef.current = loc; },
      );
    })();
    return () => { sub?.remove(); };
  }, [locPerm]);

  const requestLocationPermission = useCallback(async () => {
    const r = await Location.requestForegroundPermissionsAsync();
    const status = r.granted ? 'granted' : 'denied';
    setLocPerm(status);
    return status;
  }, []);

  const isReady = cameraPermission?.granted === true && locPerm === 'granted';

  const capture = useCallback<UsePhotoCaptureApi['capture']>(
    async (camera, opts) => {
      if (!camera) throw new Error('camera ref not ready');
      if (!cameraPermission?.granted) throw new Error('camera permission not granted');

      // ---- 1. Take the picture ----
      const shot: CameraCapturedPicture = await camera.takePictureAsync({
        quality: opts.quality ?? 0.7,
        exif: !opts.stripExif,        // keep EXIF unless caller asked to strip
        skipProcessing: false,
        // base64 is expensive; we never need it (we upload from disk)
      });

      // ---- 2. Resolve location ----
      // Prefer EXIF GPS (camera fix at the moment of capture), fall back to
      // the warm watchPosition fix.
      let geom: CapturedPhoto['geom'] = null;
      const exif = (shot as any).exif as Record<string, any> | undefined;
      if (exif?.GPSLatitude && exif?.GPSLongitude) {
        // expo-camera returns signed decimal already on iOS; on Android
        // sometimes uses N/S/E/W refs. Normalise:
        const lat = signed(exif.GPSLatitude, exif.GPSLatitudeRef);
        const lon = signed(exif.GPSLongitude, exif.GPSLongitudeRef);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          geom = { lat, lon, accuracy_m: exif?.GPSHPositioningError };
        }
      }
      if (!geom && lastFixRef.current) {
        geom = {
          lat: lastFixRef.current.coords.latitude,
          lon: lastFixRef.current.coords.longitude,
          accuracy_m: lastFixRef.current.coords.accuracy ?? undefined,
        };
      }

      // ---- 3. Persist out of the cache dir ----
      // expo-camera writes to cacheDirectory which the OS may evict. Move
      // to documentDirectory so it survives until the upload succeeds.
      const clientId = (crypto as any).randomUUID?.() ?? fallbackUuid();
      const safeName = `${opts.parentTable}-${clientId}.jpg`;
      const dest = `${FileSystem.documentDirectory}photos/${safeName}`;
      await FileSystem.makeDirectoryAsync(
        `${FileSystem.documentDirectory}photos`,
        { intermediates: true },
      ).catch(() => {/* exists */});
      await FileSystem.moveAsync({ from: shot.uri, to: dest });

      const info = await FileSystem.getInfoAsync(dest);
      const size = info.exists && 'size' in info ? info.size : 0;

      // ---- 4. Enqueue ----
      await database.write(async () => {
        const col = database.get<PhotoQueueRow>('photo_queue');
        await col.create((p) => {
          p.clientId    = clientId;
          p.parentTable = opts.parentTable;
          p.localUri    = dest;
          p.takenAt     = new Date();
          p.lat         = geom?.lat ?? undefined;
          p.lon         = geom?.lon ?? undefined;
          p.status      = 'pending';
          p.attempts    = 0;
        });
      });

      // Also append a reference into the parent row's photos JSON so it
      // shows up in the local UI immediately (the server will reconcile
      // on confirm).
      await appendLocalPhotoRef(opts.parentTable, opts.parentClientId, {
        client_id: clientId,
        local_uri: dest,
        taken_at: new Date().toISOString(),
        geom: geom ? { type: 'Point', coordinates: [geom.lon, geom.lat] } : null,
      });

      // Nudge the sync engine — it'll upload on its next run.
      getEngine().requestSync('photo_captured');

      return {
        uri: dest,
        clientId,
        size,
        width: shot.width,
        height: shot.height,
        takenAt: new Date(),
        geom,
      };
    },
    [cameraPermission],
  );

  return {
    capture,
    cameraPermission,
    requestCameraPermission: requestCamera,
    locationPermission: locPerm,
    requestLocationPermission,
    isReady,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function signed(value: number, ref?: string): number {
  if (typeof value !== 'number') return Number.NaN;
  if (ref === 'S' || ref === 'W') return -Math.abs(value);
  return Math.abs(value);
}

function fallbackUuid(): string {
  // RFC4122 v4 — only used when crypto.randomUUID isn't polyfilled
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Append a photo reference to the parent row's photos JSON column. This
 * mirrors what the server does in /sync/photos/confirm but locally, so the
 * UI shows the new photo immediately without waiting for sync.
 */
async function appendLocalPhotoRef(
  parentTable: 'crop_activity' | 'harvest' | 'qc_test',
  parentClientId: string,
  ref: Record<string, unknown>,
): Promise<void> {
  // Only crop_activity is mirrored on mobile in the current schema. Extend
  // as you mirror more tables.
  if (parentTable !== 'crop_activity') return;
  await database.write(async () => {
    const col = database.get('crop_activities');
    const found = await (col as any).query(
      // @ts-ignore — Q import omitted for brevity
      { client_id: parentClientId },
    ).fetch();
    const row = found[0];
    if (!row) return;
    const list = JSON.parse(row.photosJson || '[]');
    list.push(ref);
    await row.update((x: any) => { x.photosJson = JSON.stringify(list); });
  });
}

// =============================================================================
// Demo screen — wire into your navigator
// =============================================================================

interface CameraScreenProps {
  parentTable: CaptureOptions['parentTable'];
  parentClientId: string;
  onCaptured?: (photo: CapturedPhoto) => void;
  onClose?: () => void;
}

export function CameraScreen({
  parentTable, parentClientId, onCaptured, onClose,
}: CameraScreenProps) {
  const cameraRef = useRef<CameraView | null>(null);
  const photo = usePhotoCapture();
  const [busy, setBusy] = useState(false);

  // Permission gating
  if (!photo.cameraPermission) {
    return <Text style={styles.center}>Loading camera…</Text>;
  }
  if (!photo.cameraPermission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Camera access is required to capture activity photos.</Text>
        <Pressable style={styles.btn} onPress={photo.requestCameraPermission}>
          <Text style={styles.btnText}>Grant access</Text>
        </Pressable>
      </View>
    );
  }
  if (photo.locationPermission !== 'granted') {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>
          Location access lets us geo-tag photos so they appear at the right plot
          on the map.
        </Text>
        <Pressable style={styles.btn} onPress={photo.requestLocationPermission}>
          <Text style={styles.btnText}>Grant location</Text>
        </Pressable>
      </View>
    );
  }

  const onShoot = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      const result = await photo.capture(cameraRef.current, {
        parentTable,
        parentClientId,
        quality: 0.7,
      });
      onCaptured?.(result);
    } catch (e: any) {
      Alert.alert('Capture failed', e?.message ?? 'unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.full}>
      <CameraView ref={cameraRef} style={styles.full} facing="back">
        <View style={styles.toolbar}>
          <Pressable onPress={onClose} style={styles.iconBtn}>
            <Text style={styles.iconText}>✕</Text>
          </Pressable>
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>
              {photo.locationPermission === 'granted' ? '📍 GPS on' : '📍 no GPS'}
            </Text>
          </View>
        </View>

        <View style={styles.shutterRow}>
          <Pressable
            onPress={onShoot}
            disabled={busy}
            style={[styles.shutter, busy && styles.shutterBusy]}
          >
            <View style={styles.shutterInner} />
          </Pressable>
        </View>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  full:    { flex: 1, backgroundColor: 'black' },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  text:    { color: '#222', fontSize: 16, textAlign: 'center' },
  toolbar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : 24,
  },
  iconBtn:  { padding: 12 },
  iconText: { color: 'white', fontSize: 24, fontWeight: '600' },
  statusPill: {
    backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
  },
  statusText: { color: 'white', fontSize: 12 },
  shutterRow: {
    position: 'absolute', bottom: 48, left: 0, right: 0, alignItems: 'center',
  },
  shutter: {
    width: 78, height: 78, borderRadius: 39,
    borderWidth: 4, borderColor: 'white',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  shutterBusy: { opacity: 0.5 },
  shutterInner: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: 'white',
  },
  btn: { backgroundColor: '#2563eb', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  btnText: { color: 'white', fontWeight: '600' },
});

// =============================================================================
// Usage from an activity capture flow
// =============================================================================
//
// async function onFinishActivity() {
//   // 1. Enqueue the activity, get its client_id back
//   const activityClientId = await Queue.enqueue({
//     table: 'crop_activity',
//     op: 'create',
//     payload: { /* ...activity data... */ },
//   });
//
//   // 2. Push the camera screen, pass that id along
//   navigation.navigate('Camera', {
//     parentTable: 'crop_activity',
//     parentClientId: activityClientId,
//   });
// }
//
// =============================================================================
