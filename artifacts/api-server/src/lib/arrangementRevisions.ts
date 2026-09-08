import type {
  ArrangementSection,
  ArrangementRevisionSnapshot,
  ArrangementRevisionSummary,
} from "@workspace/db";

type PerformanceNote = NonNullable<ArrangementSection["midiNotes"]>[number];

function performanceNote(note: PerformanceNote) {
  return {
    id: note.id,
    pitch: note.pitch,
    start: note.start,
    duration: note.duration,
    velocity: note.velocity,
    articulation: note.articulation,
  };
}

/**
 * Compares only playable section data. Missing legacy containers are treated
 * like empty ones, and MIDI-track object insertion order is not musical data.
 */
export function sectionsHavePerformanceChanges(
  before: ArrangementSection[],
  after: ArrangementSection[],
): boolean {
  const performance = (sections: ArrangementSection[]) => sections.map((section) => ({
    name: section.name,
    midiNotes: (section.midiNotes ?? []).map(performanceNote),
    cc: [...(section.cc ?? [])],
    midiTracks: Object.fromEntries(
      Object.entries(section.midiTracks ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([trackId, track]) => [
          trackId,
          {
            notes: track.notes.map(performanceNote),
            cc: [...track.cc],
          },
        ]),
    ),
  }));
  return JSON.stringify(performance(before)) !== JSON.stringify(performance(after));
}

function changedEventCount<T>(
  before: Array<[string, T]>,
  after: Array<[string, T]>,
): number {
  const beforeByKey = new Map(before);
  const afterByKey = new Map(after);
  return Array.from(new Set([...beforeByKey.keys(), ...afterByKey.keys()]))
    .filter((key) =>
      JSON.stringify(beforeByKey.get(key)) !== JSON.stringify(afterByKey.get(key))
    )
    .length;
}

/**
 * Reports changes from the preceding committed snapshot. Event identifiers are
 * scoped by both section and MIDI track so identical local IDs stay distinct.
 */
export function revisionSummary(
  before: ArrangementRevisionSnapshot | null,
  after: ArrangementRevisionSnapshot,
): ArrangementRevisionSummary {
  const beforeSections = new Map((before?.sections ?? []).map((section) => [section.name, section]));
  const afterSections = new Map(after.sections.map((section) => [section.name, section]));
  const affectedSections = Array.from(
    new Set([...beforeSections.keys(), ...afterSections.keys()]),
  ).filter((name) =>
    JSON.stringify(beforeSections.get(name)) !== JSON.stringify(afterSections.get(name))
  );
  const affectedTracks = new Set<string>();
  let trackMembershipChanges = 0;
  for (const sectionName of new Set([...beforeSections.keys(), ...afterSections.keys()])) {
    const previous = beforeSections.get(sectionName);
    const next = afterSections.get(sectionName);
    const previousMembership = new Set(previous?.tracks ?? []);
    const nextMembership = new Set(next?.tracks ?? []);
    for (const trackName of new Set([...previousMembership, ...nextMembership])) {
      if (previousMembership.has(trackName) !== nextMembership.has(trackName)) {
        affectedTracks.add(trackName);
        trackMembershipChanges += 1;
      }
    }
    const previousMidi = previous?.midiTracks ?? {};
    const nextMidi = next?.midiTracks ?? {};
    for (const trackName of new Set([...Object.keys(previousMidi), ...Object.keys(nextMidi)])) {
      if (JSON.stringify(previousMidi[trackName]) !== JSON.stringify(nextMidi[trackName])) {
        affectedTracks.add(trackName);
      }
    }
  }
  const chordEvents = (snapshot: ArrangementRevisionSnapshot | null) =>
    (snapshot?.sections ?? []).flatMap((section) =>
      (section.chords ?? []).map((chord) => [`${section.name}:${chord.id}`, chord] as [string, typeof chord])
    );
  const noteEvents = (snapshot: ArrangementRevisionSnapshot | null) =>
    (snapshot?.sections ?? []).flatMap((section) => [
      ...(section.midiNotes ?? []).map((note) =>
        [`${section.name}:legacy:${note.id}`, note] as [string, typeof note]
      ),
      ...Object.entries(section.midiTracks ?? {}).flatMap(([trackName, editor]) =>
        editor.notes.map((note) =>
          [`${section.name}:${trackName}:${note.id}`, note] as [string, typeof note]
        )
      ),
    ]);
  const ccEvents = (snapshot: ArrangementRevisionSnapshot | null) =>
    (snapshot?.sections ?? []).flatMap((section) => [
      ...(section.cc ?? []).map((value, index) =>
        [`${section.name}:legacy:${index}`, value] as [string, number]
      ),
      ...Object.entries(section.midiTracks ?? {}).flatMap(([trackName, editor]) =>
        editor.cc.map((value, index) =>
          [`${section.name}:${trackName}:${index}`, value] as [string, number]
        )
      ),
    ]);
  const conductorControls = [
    ["name", "Name"],
    ["harmonyComplexity", "Harmony complexity"],
    ["energy", "Energy"],
    ["density", "Density"],
    ["orchestraSize", "Orchestra size"],
    ["rhythmIntensity", "Rhythm intensity"],
  ] as const;
  return {
    affectedSections,
    affectedTracks: [...affectedTracks].sort(),
    trackMembershipChanges,
    chordChanges: changedEventCount(chordEvents(before), chordEvents(after)),
    noteChanges: changedEventCount(noteEvents(before), noteEvents(after)),
    ccChanges: changedEventCount(ccEvents(before), ccEvents(after)),
    conductorControls: conductorControls
      .filter(([key]) => before === null || before[key] !== after[key])
      .map(([, label]) => label),
    candidateSelectionChanged:
      before !== null && before.selectedCandidateId !== after.selectedCandidateId,
  };
}