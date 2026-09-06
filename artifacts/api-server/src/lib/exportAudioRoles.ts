export const EXPORT_AUDIO_ROLES = {
  mix: "MIX",
  premaster: "PREMASTER",
  master: "MASTER",
} as const;

export type ExportAudioStage = keyof typeof EXPORT_AUDIO_ROLES;
export type ExportAudioRole = (typeof EXPORT_AUDIO_ROLES)[ExportAudioStage];

const exportAudioRoleSet = new Set<ExportAudioRole>(
  Object.values(EXPORT_AUDIO_ROLES),
);

export function exportAudioRole(stage: ExportAudioStage): ExportAudioRole {
  return EXPORT_AUDIO_ROLES[stage];
}

export function isExportAudioRole(role: string): role is ExportAudioRole {
  return exportAudioRoleSet.has(role as ExportAudioRole);
}

export function isFinalExportAudioRole(role: string): role is "MIX" | "MASTER" {
  return role === EXPORT_AUDIO_ROLES.mix || role === EXPORT_AUDIO_ROLES.master;
}