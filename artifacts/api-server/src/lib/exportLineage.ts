import type { SongModelData } from "@workspace/db";

type VersionedSongModel<T extends SongModelData = SongModelData> = {
  version: number;
  model: T;
};

export function resolveExportSongModel<T extends VersionedSongModel>(
  songModels: T[],
  requiredVersion: number | null,
): {
  songModel: T;
  bpm: number;
  key: string;
  meter: string;
} {
  if (requiredVersion === null) {
    throw new Error("The selected arrangement has no Song Model version");
  }
  const songModel = songModels.find((model) => model.version === requiredVersion);
  if (!songModel) {
    throw new Error(`Song Model version ${requiredVersion} is unavailable`);
  }
  const bpm = songModel.model.tempoMap[0]?.bpm;
  const key = songModel.model.keyMap[0]?.key;
  const meter = songModel.model.meterMap[0]?.meter;
  if (!Number.isFinite(bpm) || !key || !meter) {
    throw new Error(`Song Model version ${requiredVersion} has incomplete musical globals`);
  }
  return { songModel, bpm: bpm as number, key, meter };
}