import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Analysis,
  Arrangement,
  ArrangementSection,
  ChordEvent as SongModelChordEvent,
  HarmonyDecisionEvidence,
  SongModel,
  Track,
  ArrangementRevision
} from "@workspace/api-client-react";
import {
  useListArrangementRevisions,
  useRestoreArrangementRevision,
  getListArrangementRevisionsQueryKey,
  getListArrangementsQueryKey
} from "@workspace/api-client-react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Eraser,
  GitBranch,
  Grid3X3,
  History,
  Magnet,
  MousePointer2,
  Music2,
  Pencil,
  Plus,
  Scissors,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type {
  AutomationPoint,
  ChordEvent,
  CopilotEditorResult,
  EditorSection,
  EditorSelection,
  PianoNote,
  TimelineMarker,
} from "./editor-types";
import { EditorConflictError, EditorSaveCoordinator } from "./editor-save-coordinator";

type EditorTool = "select" | "draw" | "split" | "erase";
type DetailPanel = "chord" | "piano" | null;

type ArrangerEditorProps = {
  projectId: string;
  arrangement?: Arrangement;
  analysis?: Analysis;
  songModel?: SongModel;
  harmonyDecisions?: HarmonyDecisionEvidence[];
  tracks: Track[];
  copilotResult?: CopilotEditorResult | null;
  playheadSeconds?: number;
  timelineDurationSeconds?: number;
  onSeek?: (seconds: number) => void;
  onSelectionChange: (selection: EditorSelection) => void;
  onSectionsChange: (sections: ArrangementSection[]) => Promise<void>;
  onExplicitDecision?: (decision: { kind: "edit" | "restore"; subjectId: string; reason: string }) => void;
  onRevisionPreviewChange?: (previewing: boolean) => void;
};

const SECTION_COLORS = ["#fb7185", "#fbbf24", "#38bdf8", "#a78bfa", "#34d399", "#f97316"];
const PITCHES = ["C6", "B5", "A#5", "A5", "G#5", "G5", "F#5", "F5", "E5", "D#5", "D5", "C#5", "C5"];
const SCALE_PITCHES = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81];
const DEFAULT_CC = [42, 61, 53, 75, 64, 81, 70, 88];

function makeChord(id: string, startBeat: number, symbol: string, quality: ChordEvent["quality"]): ChordEvent {
  return { id, startBeat, durationBeats: 4, symbol, quality, inversion: 0 };
}

function chordsForSection(section: ArrangementSection, index: number, totalBeats: number): ChordEvent[] {
  const rootProgression = index % 2 === 0
    ? [["Dm", "minor"], ["Bb", "major"], ["F", "major"], ["C", "major"]]
    : [["Bb", "major"], ["F", "major"], ["C", "major"], ["Dm", "minor"]];
  return Array.from({ length: Math.max(1, Math.ceil(totalBeats / 4)) }, (_, chordIndex) => {
    const [symbol, quality] = rootProgression[chordIndex % rootProgression.length];
    return makeChord(`${section.name}-${chordIndex}`, chordIndex * 4, symbol, quality as ChordEvent["quality"]);
  });
}

function normalizeSections(
  sections: ArrangementSection[] | undefined,
  analysisSections: Analysis["sections"] | undefined,
  tracks: Track[],
): EditorSection[] {
  const source = sections?.length
    ? sections
    : (analysisSections ?? []).map((section) => ({
        name: section.name,
        startBar: section.startBar,
        endBar: section.endBar,
        energy: section.energy,
        density: Math.min(1, section.energy + 0.2),
        tracks: [],
      }));
  return source.map((section, index) => {
    const candidate = section as ArrangementSection & Partial<EditorSection>;
    const startBar = candidate.startBar ?? analysisSections?.[index]?.startBar ?? index * 8 + 1;
    const endBar = candidate.endBar ?? analysisSections?.[index]?.endBar ?? startBar + 7;
    const midiTrackNames = tracks.filter((track) => track.kind === "midi").map((track) => track.name);
    const legacyNotes = candidate.midiNotes?.length ? candidate.midiNotes : noteSeed(index);
    const legacyCc = candidate.cc?.length ? candidate.cc : DEFAULT_CC;
    const midiTracks = candidate.midiTracks ?? Object.fromEntries(
      midiTrackNames.map((trackName, trackIndex) => [
        trackName,
        { notes: trackIndex === 0 ? legacyNotes : noteSeed(index + trackIndex), cc: legacyCc },
      ]),
    );
    return {
      ...section,
      startBar,
      endBar: Math.max(startBar, endBar),
      chords: candidate.chords?.length ? candidate.chords : chordsForSection(section, index, (endBar - startBar + 1) * 4),
      markers: candidate.markers ?? [],
      automation: candidate.automation ?? [
        { bar: startBar, value: section.energy },
        { bar: endBar, value: section.energy },
      ],
      midiNotes: candidate.midiNotes?.length ? candidate.midiNotes : noteSeed(index),
      cc: legacyCc,
      midiTracks,
      transposeSemitones: candidate.transposeSemitones ?? 0,
    };
  });
}

function noteSeed(trackIndex: number): PianoNote[] {
  const root = 60 + (trackIndex % 3) * 5;
  return Array.from({ length: 6 }, (_, index) => ({
    id: `seed-${trackIndex}-${index}`,
    pitch: root + [0, 4, 7, 12, 7, 4][index],
    start: index * 2,
    duration: index % 2 ? 1.5 : 2,
    velocity: 72 + (index % 3) * 10,
    articulation: index === 2 ? "accent" : "sustain",
  }));
}

function waveform(trackIndex: number) {
  return Array.from({ length: 44 }, (_, index) => 18 + ((index * 17 + trackIndex * 23) % 37));
}

function sectionToApi(section: EditorSection): ArrangementSection {
  return section;
}

function revisionControlComparison(
  revision: ArrangementRevision,
  arrangement: Arrangement,
) {
  const controls = [
    {
      label: "Harmony",
      revision: `${revision.snapshot.harmonyComplexity}/10`,
      current: `${arrangement.harmonyComplexity}/10`,
      changed: revision.snapshot.harmonyComplexity !== arrangement.harmonyComplexity,
    },
    ...([
      ["Energy", revision.snapshot.energy, arrangement.energy],
      ["Density", revision.snapshot.density, arrangement.density],
      ["Orchestra", revision.snapshot.orchestraSize, arrangement.orchestraSize],
      ["Rhythm", revision.snapshot.rhythmIntensity, arrangement.rhythmIntensity],
    ] as const).map(([label, previous, current]) => ({
      label,
      revision: `${Math.round(previous * 100)}%`,
      current: `${Math.round(current * 100)}%`,
      changed: previous !== current,
    })),
    {
      label: "Candidate",
      revision: revision.snapshot.selectedCandidateId ?? "None",
      current: arrangement.selectedCandidateId ?? "None",
      changed: revision.snapshot.selectedCandidateId !== arrangement.selectedCandidateId,
    },
  ];
  const currentSections = new Map(arrangement.sections.map((section) => [section.name, section]));
  const revisionSections = new Map(revision.snapshot.sections.map((section) => [section.name, section]));
  const affectedSections = Array.from(
    new Set([...currentSections.keys(), ...revisionSections.keys()]),
  ).filter((name) =>
    JSON.stringify(currentSections.get(name)) !== JSON.stringify(revisionSections.get(name))
  );
  return {
    controls: controls.filter((control) => control.changed),
    affectedSections,
  };
}

export function ArrangerEditor({
  projectId,
  arrangement,
  analysis,
  songModel,
  harmonyDecisions = [],
  tracks,
  copilotResult,
  playheadSeconds = 0,
  timelineDurationSeconds = 0,
  onSeek,
  onSelectionChange,
  onSectionsChange,
  onExplicitDecision,
  onRevisionPreviewChange,
}: ArrangerEditorProps) {
  const { toast } = useToast();
  const [tool, setTool] = useState<EditorTool>("select");
  const [snap, setSnap] = useState(true);
  const [snapValue, setSnapValue] = useState("1/16");
  const [selectedSectionName, setSelectedSectionName] = useState<string | null>(null);
  const [selectedChordId, setSelectedChordId] = useState<string | null>(null);
  const [detailPanel, setDetailPanel] = useState<DetailPanel>(null);
  const [openAutomation, setOpenAutomation] = useState<Record<string, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const saveCoordinator = useRef(new EditorSaveCoordinator());
  const [savePass, setSavePass] = useState(0);
  const firstMidiTrackName = tracks.find((track) => track.kind === "midi")?.name ?? "MIDI";
  const [selectedTrackName, setSelectedTrackName] = useState(firstMidiTrackName);
  const initialSections = normalizeSections(arrangement?.sections, analysis?.sections, tracks);
  const [notes, setNotes] = useState<PianoNote[]>(() => initialSections[0]?.midiTracks[firstMidiTrackName]?.notes ?? noteSeed(2));
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [ccPoints, setCcPoints] = useState<number[]>(() => initialSections[0]?.midiTracks[firstMidiTrackName]?.cc ?? DEFAULT_CC);
  const [articulation, setArticulation] = useState<PianoNote["articulation"]>("sustain");
  const lastArrangementRevision = useRef<string | null>(null);
  const appliedCopilotResult = useRef<CopilotEditorResult | null>(null);

  const [sections, setSections] = useState<EditorSection[]>(initialSections);

  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [previewRevisionId, setPreviewRevisionId] = useState<string | null>(null);
  const stashedSections = useRef<EditorSection[] | null>(null);

  const { data: revisions, isLoading: isLoadingRevisions } = useListArrangementRevisions(arrangement?.id || "", {
    query: {
      enabled: showHistory && !!arrangement?.id,
      queryKey: getListArrangementRevisionsQueryKey(arrangement?.id || ""),
    }
  });

  const restoreMutation = useRestoreArrangementRevision();

  const startPreview = (revision: ArrangementRevision) => {
    if (revision.version === arrangement?.version) {
      cancelPreview();
      return;
    }
    if (!previewRevisionId) {
      stashedSections.current = sections;
    }
    const normalized = normalizeSections(revision.snapshot.sections, analysis?.sections, tracks);
    const hydratedSection = normalized.find((section) => section.name === selectedSectionName) ?? normalized[0];
    const defaultTrackName = tracks.find((track) => track.kind === "midi")?.name ?? "MIDI";
    const trackName = hydratedSection?.midiTracks[selectedTrackName]
      ? selectedTrackName
      : defaultTrackName;
    setPreviewRevisionId(revision.id);
    setSections(normalized);
    setSelectedSectionName(hydratedSection?.name ?? null);
    setSelectedTrackName(trackName);
    setNotes(hydratedSection?.midiTracks[trackName]?.notes ?? noteSeed(2));
    setCcPoints(hydratedSection?.midiTracks[trackName]?.cc ?? DEFAULT_CC);
    onRevisionPreviewChange?.(true);
  };

  const cancelPreview = () => {
    setPreviewRevisionId(null);
    if (stashedSections.current) {
      const restoredSections = stashedSections.current;
      setSections(restoredSections);
      const hydratedSection = restoredSections.find((section) => section.name === selectedSectionName) ?? restoredSections[0];
      const defaultTrackName = tracks.find((track) => track.kind === "midi")?.name ?? "MIDI";
      const trackName = hydratedSection?.midiTracks[selectedTrackName]
        ? selectedTrackName
        : defaultTrackName;
      setSelectedSectionName(hydratedSection?.name ?? null);
      setSelectedTrackName(trackName);
      setNotes(hydratedSection?.midiTracks[trackName]?.notes ?? noteSeed(2));
      setCcPoints(hydratedSection?.midiTracks[trackName]?.cc ?? DEFAULT_CC);
      stashedSections.current = null;
    }
    onRevisionPreviewChange?.(false);
  };

  const handleRestore = (revision: ArrangementRevision) => {
    if (!arrangement) return;
    restoreMutation.mutate({
      arrangementId: arrangement.id,
      revisionId: revision.id,
      data: { expectedVersion: arrangement.version }
    }, {
      onSuccess: (restoredArr) => {
        setPreviewRevisionId(null);
        stashedSections.current = null;
        setDirty(false);
        setShowHistory(false);
        onRevisionPreviewChange?.(false);
        queryClient.setQueryData(getListArrangementsQueryKey(projectId), (current: Arrangement[] | undefined) =>
          current?.map(a => a.id === restoredArr.id ? restoredArr : a)
        );
        void queryClient.invalidateQueries({
          queryKey: getListArrangementRevisionsQueryKey(arrangement.id),
        });
        toast({
          title: `Revision v${revision.version} restored`,
          description: `The restored arrangement is now v${restoredArr.version}; newer history was preserved.`,
        });
        onExplicitDecision?.({
          kind: "restore",
          subjectId: restoredArr.id,
          reason: `Restored arrangement revision v${revision.version}.`,
        });
      },
      onError: async (restoreError) => {
        if (
          restoreError
          && typeof restoreError === "object"
          && "status" in restoreError
          && restoreError.status === 409
        ) {
          cancelPreview();
          await queryClient.refetchQueries({
            queryKey: getListArrangementsQueryKey(projectId),
          });
          toast({
            title: "Arrangement changed before restore",
            description: "The latest revision was loaded. Review the history and try again.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Revision could not be restored",
          description: restoreError instanceof Error ? restoreError.message : "Try restoring this revision again.",
          variant: "destructive",
        });
      }
    });
  };

  useEffect(() => {
    const revision = arrangement ? `${arrangement.id}:${arrangement.version}` : null;
    if (arrangement?.id && revision && lastArrangementRevision.current !== revision) {
      if (dirty || previewRevisionId) return;
      lastArrangementRevision.current = revision;
      const normalized = normalizeSections(arrangement.sections, analysis?.sections, tracks);
      setSections(normalized);
      setDirty(false);
      const hydratedSection = normalized.find((section) => section.name === selectedSectionName) ?? normalized[0];
      const defaultTrackName = tracks.find((track) => track.kind === "midi")?.name ?? "MIDI";
      const trackName = hydratedSection?.midiTracks[selectedTrackName]
        ? selectedTrackName
        : defaultTrackName;
      setSelectedTrackName(trackName);
      setNotes(hydratedSection?.midiTracks[trackName]?.notes ?? noteSeed(2));
      setCcPoints(hydratedSection?.midiTracks[trackName]?.cc ?? DEFAULT_CC);
    }
  }, [arrangement, analysis?.sections, dirty, previewRevisionId, selectedSectionName, selectedTrackName, tracks]);

  useEffect(() => () => {
    onRevisionPreviewChange?.(false);
  }, [onRevisionPreviewChange]);

  useEffect(() => {
    if (!dirty || hasConflict || saveCoordinator.current.hasInFlightSave() || previewRevisionId) return;
    const timeout = window.setTimeout(() => {
      const savingGeneration = saveCoordinator.current.beginSave();
      if (savingGeneration === null) return;
      void onSectionsChange(sections.map(sectionToApi))
        .then(() => {
          const acknowledgement = saveCoordinator.current.acknowledge(savingGeneration);
          if (acknowledgement === "synced") {
            setDirty(false);
            if (arrangement) {
              onExplicitDecision?.({
                kind: "edit",
                subjectId: arrangement.id,
                reason: "Saved explicit timeline edits.",
              });
            }
          } else if (acknowledgement === "resave") {
            setSavePass((pass) => pass + 1);
          }
        })
        .catch((error: unknown) => {
          saveCoordinator.current.reject(savingGeneration);
          if (error instanceof EditorConflictError) setHasConflict(true);
          setDirty(true);
        });
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [arrangement, dirty, hasConflict, onExplicitDecision, onSectionsChange, previewRevisionId, savePass, sections]);

  useEffect(() => {
    if (!copilotResult || appliedCopilotResult.current === copilotResult || previewRevisionId) return;
    appliedCopilotResult.current = copilotResult;
    const affected = copilotResult.affectedSections;
    setSections((current) => current.map((section) => {
      if (!affected.includes("Full arrangement") && !affected.includes(section.name)) return section;
      return copilotResult.operations.reduce((next, operation) => {
        if (operation.targetSection && operation.targetSection !== section.name) return next;
        const scopeStart = operation.startBar ?? section.startBar;
        const scopeEnd = operation.endBar ?? section.endBar;
        const coversWholeSection = scopeStart <= section.startBar && scopeEnd >= section.endBar;
        if (operation.type === "MODULATE") {
          return coversWholeSection
            ? { ...next, energy: Math.min(1, next.energy + 0.08), transposeSemitones: Math.min(24, next.transposeSemitones + 2) }
            : next;
        }
        if (operation.type === "SET_SECTION_ENERGY") {
          const scopedAutomation = [
            ...next.automation.filter((point) => point.bar < scopeStart || point.bar > scopeEnd),
            { bar: scopeStart, value: Math.min(1, next.energy + 0.14) },
            { bar: scopeEnd, value: Math.min(1, next.energy + 0.14) },
          ].sort((a, b) => a.bar - b.bar);
          return { ...next, ...(coversWholeSection ? { energy: Math.min(1, next.energy + 0.14) } : {}), automation: scopedAutomation };
        }
        if (operation.type === "SET_SECTION_DENSITY") {
          return coversWholeSection ? { ...next, density: Math.max(0, next.density - 0.14) } : next;
        }
        if (operation.type === "REHARMONIZE_CHORDS") {
          return {
            ...next,
            chords: next.chords.map((chord, index) => {
              const chordBar = section.startBar + Math.floor(chord.startBeat / 4);
              return chordBar >= scopeStart && chordBar <= scopeEnd
                ? { ...chord, symbol: index % 2 ? "Fmaj7" : "Gm9", quality: index % 2 ? "major" : "minor" }
                : chord;
            }),
          };
        }
        if (operation.type === "ADD_COUNTERMELODY") {
          return coversWholeSection
            ? { ...next, density: Math.min(1, next.density + 0.12), tracks: next.tracks.includes("Cello") ? next.tracks : [...next.tracks, "Cello"] }
            : next;
        }
        if (operation.type === "UPDATE_TRACK") {
          return coversWholeSection ? {
            ...next,
            density: Math.min(1, next.density + 0.06),
            tracks: operation.targetTrack && !next.tracks.includes(operation.targetTrack)
              ? [...next.tracks, operation.targetTrack]
              : next.tracks,
          } : next;
        }
        return next;
      }, section);
    }));
    saveCoordinator.current.markChanged();
    setDirty(true);
  }, [copilotResult, previewRevisionId]);

  const beatsPerBar = Number(analysis?.meter?.split("/")[0]) || 4;
  const bpm = analysis?.bpm || 120;
  const audioBarCount = timelineDurationSeconds > 0
    ? Math.max(1, Math.ceil(timelineDurationSeconds / ((60 / bpm) * beatsPerBar)))
    : 1;
  const arrangementBarCount = useMemo(
    () => Math.max(audioBarCount, ...sections.map((section) => section.endBar)),
    [audioBarCount, sections],
  );
  const barCount = Math.max(88, arrangementBarCount);
  const timelineWidth = barCount * 42;
  const playheadBar = timelineDurationSeconds > 0
    ? 1 + Math.min(1, playheadSeconds / timelineDurationSeconds) * (arrangementBarCount - 1)
    : 1;
  const playheadPercent = ((playheadBar - 1) / barCount) * 100;
  const activePlaybackSection = sections.find((section) =>
    playheadBar >= section.startBar && playheadBar <= section.endBar
  );
  const selectedSection = sections.find((section) => section.name === selectedSectionName) ?? sections[0];
  const selectedSectionBeatCount = selectedSection
    ? Math.max(4, (selectedSection.endBar - selectedSection.startBar + 1) * 4)
    : 16;
  const selectedChord = selectedSection?.chords.find((chord) => chord.id === selectedChordId) ?? selectedSection?.chords[0];
  const selectedChordEvidence = useMemo<SongModelChordEvent | undefined>(() => {
    if (!songModel || !selectedSection || !selectedChord) return undefined;
    const beatsPerBarAtSelection = Number(analysis?.meter?.split("/")[0]) || 4;
    const absoluteBeat = (selectedSection.startBar - 1) * beatsPerBarAtSelection + selectedChord.startBeat;
    const beatMatches = songModel.chords
      .filter((chord) => chord.timing?.startBeat !== undefined)
      .sort((left, right) =>
        Math.abs((left.timing?.startBeat ?? 0) - absoluteBeat)
        - Math.abs((right.timing?.startBeat ?? 0) - absoluteBeat)
      );
    if (beatMatches[0] && Math.abs((beatMatches[0].timing?.startBeat ?? 0) - absoluteBeat) < beatsPerBarAtSelection) {
      return beatMatches[0];
    }
    const bar = songModel.bars.find((candidate) => candidate.bar === selectedSection.startBar);
    if (!bar) return undefined;
    const secondsPerBeat = (bar.end - bar.start) / Math.max(1, bar.beats);
    const chordTime = bar.start + selectedChord.startBeat * secondsPerBeat;
    return songModel.chords.find((chord) => chord.start <= chordTime && chord.end > chordTime);
  }, [analysis?.meter, selectedChord, selectedSection, songModel]);
  const selectedHarmonyDecision = useMemo<HarmonyDecisionEvidence | undefined>(() => {
    if (!selectedSection || !selectedChord || !songModel?.bars.length) return undefined;
    const bar = songModel.bars.find((candidate) => candidate.bar === selectedSection.startBar);
    if (!bar) return undefined;
    const secondsPerBeat = (bar.end - bar.start) / Math.max(1, bar.beats);
    const chordTime = bar.start + selectedChord.startBeat * secondsPerBeat;
    return harmonyDecisions.find((decision) => decision.start <= chordTime && decision.end > chordTime);
  }, [harmonyDecisions, selectedChord, selectedSection, songModel?.bars]);
  const selectedNote = notes.find((note) => note.id === selectedNoteId);
  const snapStep = snap && snapValue !== "off"
    ? ({ "1/4": 1, "1/8": 0.5, "1/16": 0.25, triplet: 1 / 3 }[snapValue] ?? 0.25)
    : 0.125;

  const updateSections = (updater: (current: EditorSection[]) => EditorSection[]) => {
    if (previewRevisionId) return;
    setSections((current) => updater(current));
    saveCoordinator.current.markChanged();
    setDirty(true);
  };

  const loadTrackEditor = (section: EditorSection, trackName: string) => {
    const editor = section.midiTracks[trackName] ?? { notes: noteSeed(tracks.findIndex((track) => track.name === trackName)), cc: DEFAULT_CC };
    setSelectedTrackName(trackName);
    setNotes(editor.notes);
    setCcPoints(editor.cc);
  };

  const seekToBar = (bar: number) => {
    if (!onSeek || timelineDurationSeconds <= 0) return;
    const ratio = Math.max(0, Math.min(1, (bar - 1) / arrangementBarCount));
    onSeek(ratio * timelineDurationSeconds);
  };

  const selectSection = (section: EditorSection) => {
    setSelectedSectionName(section.name);
    setSelectedChordId(null);
    setDetailPanel(null);
    loadTrackEditor(section, selectedTrackName);
    onSelectionChange({ kind: "section", sectionName: section.name, startBar: section.startBar, endBar: section.endBar });
    seekToBar(section.startBar);
  };

  const selectChord = (section: EditorSection, chord: ChordEvent) => {
    setSelectedSectionName(section.name);
    setSelectedChordId(chord.id);
    setDetailPanel("chord");
    loadTrackEditor(section, selectedTrackName);
    onSelectionChange({
      kind: "chord",
      sectionName: section.name,
      chordId: chord.id,
      startBar: section.startBar,
      endBar: section.endBar,
    });
    seekToBar(section.startBar + chord.startBeat / 4);
  };

  const handleTimelineSeek = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSeek || timelineDurationSeconds <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seekToBar(1 + ratio * barCount);
  };

  const updateSelectedSection = (updates: Partial<EditorSection>) => {
    if (!selectedSection) return;
    updateSections((current) => current.map((section) =>
      section.name === selectedSection.name ? { ...section, ...updates } : section,
    ));
  };

  const updateSelectedChord = (updates: Partial<ChordEvent>) => {
    if (!selectedSection || !selectedChord) return;
    updateSections((current) => current.map((section) => section.name !== selectedSection.name
      ? section
      : { ...section, chords: section.chords.map((chord) => chord.id === selectedChord.id ? { ...chord, ...updates } : chord) }));
  };

  const applyChordAction = (action: "reharmonize" | "simplify" | "richen" | "invert" | "bass" | "alternative") => {
    if (!selectedSection || !selectedChord) return;
    const changesByAction: Record<typeof action, Partial<ChordEvent>> = {
      reharmonize: { symbol: selectedChord.symbol === "Dm" ? "Gm7" : "Dm7", quality: "minor" },
      simplify: { symbol: selectedChord.symbol.replace(/7|9|11/g, ""), durationBeats: 4 },
      richen: { symbol: `${selectedChord.symbol}9`, durationBeats: 4 },
      invert: { inversion: (selectedChord.inversion + 1) % 3 },
      bass: { bass: selectedChord.symbol.slice(0, 1) === "D" ? "A" : "C" },
      alternative: { symbol: selectedChord.symbol === "F" ? "Am7" : "Fmaj7", quality: "major" },
    };
    updateSelectedChord(changesByAction[action]);
  };

  const toggleTrackInSection = (trackName: string) => {
    if (!selectedSection) return;
    const active = selectedSection.tracks.includes(trackName);
    updateSelectedSection({ tracks: active
      ? selectedSection.tracks.filter((name) => name !== trackName)
      : [...selectedSection.tracks, trackName] });
  };

  const addMarker = () => {
    if (!selectedSection) return;
    const marker: TimelineMarker = {
      id: `marker-${Date.now()}`,
      bar: selectedSection.startBar,
      label: "Cue",
      color: "#fb7185",
    };
    updateSelectedSection({ markers: [...selectedSection.markers, marker] });
  };

  const handlePianoGridClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tool === "erase") {
      if (selectedNoteId) {
        updateNotes((current) => current.filter((note) => note.id !== selectedNoteId));
        setSelectedNoteId(null);
      }
      return;
    }
    if (tool !== "draw") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const step = snapStep;
    const start = Math.max(0, Math.min(
      selectedSectionBeatCount - 1,
      Math.round(((event.clientX - rect.left) / rect.width) * selectedSectionBeatCount / step) * step,
    ));
    const row = Math.max(0, Math.min(PITCHES.length - 1, Math.floor(((event.clientY - rect.top) / rect.height) * PITCHES.length)));
    const newNote: PianoNote = {
      id: `note-${Date.now()}`,
      pitch: SCALE_PITCHES[SCALE_PITCHES.length - row - 1],
      start,
      duration: Math.max(step, 1),
      velocity: 80,
      articulation,
    };
    updateNotes((current) => [...current, newNote]);
    setSelectedNoteId(newNote.id);
    setDetailPanel("piano");
  };

  const updateNotes = (updater: (current: PianoNote[]) => PianoNote[]) => {
    if (previewRevisionId) return;
    const updated = updater(notes);
    setNotes(updated);
    if (selectedSection) {
      setSections((sectionsCurrent) => sectionsCurrent.map((section) =>
        section.name === selectedSection.name
          ? {
              ...section,
              midiTracks: {
                ...section.midiTracks,
                [selectedTrackName]: {
                  notes: updated,
                  cc: section.midiTracks[selectedTrackName]?.cc ?? ccPoints,
                },
              },
            }
          : section,
      ));
    }
    saveCoordinator.current.markChanged();
    setDirty(true);
  };

  const applyNoteOperation = (operation: "quantize" | "humanize" | "transpose" | "duplicate" | "resize" | "move") => {
    if (!selectedNote) return;
    updateNotes((current) => {
      if (operation === "duplicate") {
        const duplicateStart = selectedNote.start + selectedNote.duration;
        return duplicateStart + selectedNote.duration <= selectedSectionBeatCount
          ? [...current, { ...selectedNote, id: `note-${Date.now()}`, start: duplicateStart }]
          : current;
      }
      return current.map((note) => {
        if (note.id !== selectedNote.id) return note;
        if (operation === "quantize") return { ...note, start: Math.min(selectedSectionBeatCount - note.duration, Math.round(note.start / snapStep) * snapStep) };
        if (operation === "humanize") return { ...note, start: Math.max(0, Math.min(selectedSectionBeatCount - note.duration, note.start + (note.start % 2 ? -0.08 : 0.08))), velocity: Math.max(1, Math.min(127, note.velocity + (note.velocity % 2 ? -4 : 4))) };
        if (operation === "transpose") return { ...note, pitch: Math.max(36, Math.min(96, note.pitch + 2)) };
        if (operation === "move") return { ...note, start: Math.min(selectedSectionBeatCount - note.duration, note.start + snapStep) };
        return {
          ...note,
          duration: Math.min(
            selectedSectionBeatCount - note.start,
            Math.max(snapStep, note.duration + (operation === "resize" ? snapStep : 0)),
          ),
        };
      });
    });
  };

  const splitNote = (note: PianoNote) => {
    const splitDuration = Math.round((note.duration / 2) / snapStep) * snapStep;
    if (splitDuration < snapStep || note.duration - splitDuration < snapStep) return;
    const secondId = `note-${Date.now()}-split`;
    updateNotes((current) => current.flatMap((candidate) => candidate.id === note.id
      ? [
          { ...candidate, duration: splitDuration },
          {
            ...candidate,
            id: secondId,
            start: candidate.start + splitDuration,
            duration: candidate.duration - splitDuration,
          },
        ]
      : candidate));
    setSelectedNoteId(secondId);
  };

  const updateCcPoint = (pointIndex: number) => {
    if (previewRevisionId) return;
    const updated = ccPoints.map((value, index) => index === pointIndex ? Math.min(127, value + 8) : value);
    setCcPoints(updated);
    if (selectedSection) {
      updateSelectedSection({
        midiTracks: {
          ...selectedSection.midiTracks,
          [selectedTrackName]: {
            notes,
            cc: updated,
          },
        },
      });
    }
  };

  const headerTools: Array<{ id: EditorTool; label: string; icon: typeof MousePointer2 }> = [
    { id: "select", label: "Select / move", icon: MousePointer2 },
    { id: "draw", label: "Draw", icon: Pencil },
    { id: "split", label: "Split", icon: Scissors },
    { id: "erase", label: "Erase", icon: Eraser },
  ];

  return (
    <div className="flex h-full flex-col relative min-h-0">
      <div className={cn("flex flex-1 min-h-0 flex-col gap-3 overflow-auto pr-1", showHistory && "xl:mr-80 xl:pr-4 transition-all duration-300")}>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-3 py-2 shadow-sm shrink-0">
          <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border bg-muted/30 p-0.5">
            {headerTools.map(({ id, label, icon: Icon }) => (
              <Button
                key={id}
                variant={tool === id ? "secondary" : "ghost"}
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-xs"
                title={label}
                onClick={() => {
                  if (id === "erase" && detailPanel === "piano" && selectedNoteId) {
                    updateNotes((current) => current.filter((note) => note.id !== selectedNoteId));
                    setSelectedNoteId(null);
                  }
                  setTool(id);
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">{label.split(" ")[0]}</span>
              </Button>
            ))}
          </div>
          <div
            data-testid="transport-bar-readout"
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span className="font-mono text-foreground md:hidden">
              Bar {Math.floor(playheadBar)} / {arrangementBarCount}
            </span>
            <span className="hidden items-center gap-1.5 md:flex">
              <span className="font-mono text-foreground">Bar {Math.floor(playheadBar)}</span>
              <span>·</span>
              <span className="max-w-28 truncate">{activePlaybackSection?.name ?? "Timeline"}</span>
              <span>/</span>
              <span>{arrangementBarCount} bars</span>
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showHistory ? "secondary" : "ghost"}
            size="sm"
            className={cn("h-8 gap-1.5 text-xs", showHistory && "bg-secondary text-secondary-foreground")}
            disabled={dirty || saveCoordinator.current.hasInFlightSave()}
            title={dirty ? "Wait for local edits to finish saving" : "Open revision history"}
            onClick={() => {
              if (showHistory) cancelPreview();
              setShowHistory(!showHistory);
            }}
          >
            <History className="h-3.5 w-3.5" />
            History
          </Button>

          <Button variant={snap ? "secondary" : "ghost"} size="sm" className="h-8 gap-1.5 text-xs" onClick={() => setSnap((value) => !value)}>
            <Magnet className="h-3.5 w-3.5" />
            Snap
          </Button>
          <Select value={snapValue} onValueChange={setSnapValue}>
            <SelectTrigger className="h-8 w-[82px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1/4">1/4</SelectItem>
              <SelectItem value="1/8">1/8</SelectItem>
              <SelectItem value="1/16">1/16</SelectItem>
              <SelectItem value="triplet">Triplet</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" className={cn("font-mono text-[10px]", dirty && "border-primary/50 text-primary")}>
            {dirty ? "saving local edit…" : `v${arrangement?.version ?? 1} · synced`}
          </Badge>
        </div>
      </div>
      {previewRevisionId && (
        <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2 text-xs shadow-sm shrink-0">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-medium text-primary">Previewing older revision</span>
          <span className="text-muted-foreground text-[10px] hidden sm:inline">Auto-save is paused. Restore this revision from the history panel to continue editing.</span>
          <Button variant="outline" size="sm" className="ml-auto h-7 text-[10px] bg-background" onClick={cancelPreview}>Exit Preview</Button>
        </div>
      )}
      {hasConflict && (
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900">
          <span className="mr-auto">A newer arrangement revision exists. Resolve it before saving again.</span>
          <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => {
            setHasConflict(false);
            setDirty(false);
          }}>Load latest</Button>
          <Button size="sm" className="h-7 text-[10px]" onClick={() => {
            setHasConflict(false);
            setSavePass((pass) => pass + 1);
          }}>Apply local edit</Button>
        </div>
      )}

      <Card className="overflow-hidden border shadow-sm flex flex-1 flex-col min-h-0 shrink-0">
        <CardHeader className="flex flex-row items-center justify-between border-b bg-muted/10 px-4 py-2.5 shrink-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Grid3X3 className="h-4 w-4 text-primary" />
            Arranger
            <span className="font-normal text-muted-foreground">/ timeline</span>
          </CardTitle>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="h-2 w-2 rounded-full bg-primary" /> semantic lanes
            <span className="ml-2 h-2 w-2 rounded-full bg-sky-400" /> MIDI
            <span className="ml-2 h-2 w-2 rounded-full bg-emerald-400" /> audio
          </div>
        </CardHeader>
        <CardContent className="p-0 flex flex-1 min-h-0 overflow-auto relative">
          <div className="flex min-h-[360px] w-full">
            <div className="sticky left-0 z-20 w-36 shrink-0 border-r bg-card">
              <div className="h-9 border-b bg-muted/20 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Tracks</div>
              <div className="h-9 border-b bg-primary/5 px-3 py-2 text-[10px] font-semibold text-primary">Sections</div>
              <div className="h-11 border-b bg-violet-500/5 px-3 py-2 text-[10px] font-semibold text-violet-600">Chords</div>
              <div className="h-8 border-b bg-amber-500/5 px-3 py-2 text-[10px] font-semibold text-amber-700">Markers</div>
              {tracks.map((track) => (
                <div key={track.id} className="flex h-14 items-center gap-2 border-b px-3 text-xs">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: track.color }} />
                  <span className="min-w-0 flex-1 truncate">{track.name}</span>
                  <span className="font-mono text-[9px] text-muted-foreground">{track.kind === "midi" ? "MIDI" : "WAV"}</span>
                </div>
              ))}
              <div className="h-9 border-b bg-orange-500/5 px-3 py-2 text-[10px] font-semibold text-orange-700">Automation</div>
            </div>

            <div className="relative" style={{ minWidth: timelineWidth }}>
              <div
                className="grid h-9 cursor-pointer border-b bg-muted/20"
                style={{ gridTemplateColumns: `repeat(${barCount}, 42px)` }}
                onClick={handleTimelineSeek}
                role="slider"
                aria-label="Arrangement playhead"
                aria-valuemin={1}
                aria-valuemax={arrangementBarCount}
                aria-valuenow={Math.floor(playheadBar)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") seekToBar(playheadBar - 1);
                  if (event.key === "ArrowRight") seekToBar(playheadBar + 1);
                }}
              >
                {Array.from({ length: barCount }, (_, index) => (
                  <div key={index} className={cn("border-r px-1 pt-2 font-mono text-[9px] text-muted-foreground", index % 4 === 0 && "border-r-foreground/20 font-bold text-foreground")}>
                    {index % 4 === 0 ? String(index + 1).padStart(2, "0") : "·"}
                  </div>
                ))}
              </div>
              <div className="relative h-9 border-b bg-primary/[0.03]">
                {sections.map((section, index) => (
                  <button
                    type="button"
                    key={section.name}
                    onClick={() => selectSection(section)}
                    className={cn(
                      "absolute inset-y-1 rounded border px-2 text-left text-[10px] font-semibold transition-shadow hover:shadow-sm",
                      selectedSectionName === section.name
                        ? "border-primary ring-1 ring-primary/40"
                        : activePlaybackSection?.name === section.name
                          ? "border-primary/70 ring-1 ring-primary/20"
                          : "border-primary/20",
                    )}
                    style={{ left: `${((section.startBar - 1) / barCount) * 100}%`, width: `${((section.endBar - section.startBar + 1) / barCount) * 100}%`, backgroundColor: `${SECTION_COLORS[index % SECTION_COLORS.length]}16` }}
                  >
                    {section.name}
                  </button>
                ))}
              </div>
              <div className="relative h-11 border-b bg-violet-500/[0.03]">
                {sections.flatMap((section) => section.chords.map((chord) => (
                  <button
                    type="button"
                    key={chord.id}
                    onClick={() => selectChord(section, chord)}
                    className={cn("absolute top-1.5 h-8 rounded border px-2 text-left font-mono text-[10px] transition-colors", selectedChordId === chord.id ? "border-violet-500 bg-violet-500/20 text-violet-800" : "border-violet-400/30 bg-violet-400/10 hover:bg-violet-400/20")}
                    style={{
                      left: `${((section.startBar - 1 + chord.startBeat / 4) / barCount) * 100}%`,
                      width: `${(Math.max(1, chord.durationBeats / 4) / barCount) * 100}%`,
                    }}
                  >
                    {chord.symbol}{chord.inversion ? ` / ${chord.inversion}` : ""}
                  </button>
                )))}
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 z-30 w-px bg-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.2)]"
                style={{ left: `${playheadPercent}%` }}
                data-testid="arrangement-playhead"
                data-playhead-bar={playheadBar.toFixed(3)}
                aria-hidden="true"
              >
                <span className="absolute -left-[4px] top-0 h-0 w-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-primary" />
              </div>
              <div className="relative h-8 border-b bg-amber-500/[0.03]">
                {sections.flatMap((section) => section.markers.map((marker) => (
                  <button key={marker.id} type="button" title={marker.label} onClick={() => selectSection(section)} className="absolute top-1 h-6 w-px bg-amber-500" style={{ left: `${((marker.bar - 1) / barCount) * 100}%` }}>
                    <span className="absolute -left-1 -top-0.5 h-2 w-2 rotate-45 bg-amber-500" />
                  </button>
                )))}
                <button type="button" onClick={addMarker} className="absolute right-3 top-1 flex h-6 items-center gap-1 rounded border border-dashed px-1.5 text-[9px] text-muted-foreground hover:border-primary hover:text-primary">
                  <Plus className="h-3 w-3" /> cue
                </button>
              </div>
              {tracks.map((track, trackIndex) => (
                <div key={track.id} className="relative h-14 border-b bg-background/70">
                  {sections.map((section, sectionIndex) => {
                    const isActive = !section.tracks.length || section.tracks.includes(track.name);
                    return (
                      <button
                        type="button"
                        key={`${track.id}-${section.name}`}
                        onClick={() => {
                          setSelectedSectionName(section.name);
                          onSelectionChange({ kind: "track", trackName: track.name, sectionName: section.name, startBar: section.startBar, endBar: section.endBar });
                          if (track.kind === "midi") {
                            loadTrackEditor(section, track.name);
                            setDetailPanel("piano");
                          } else {
                            setDetailPanel(null);
                          }
                        }}
                        className={cn("absolute inset-y-2 rounded border text-left transition-opacity hover:brightness-95", !isActive && "opacity-25", track.kind === "midi" ? "border-sky-400/40 bg-sky-400/10" : "border-emerald-400/40 bg-emerald-400/10")}
                        style={{ left: `${((section.startBar - 1) / barCount) * 100}%`, width: `${((section.endBar - section.startBar + 1) / barCount) * 100}%` }}
                      >
                        <span className="absolute inset-x-1 top-1 flex items-end gap-0.5 overflow-hidden">
                          {waveform(trackIndex).slice(0, Math.max(3, Math.floor((section.endBar - section.startBar + 1) / 2))).map((height, index) => (
                            <i key={index} className={cn("w-0.5 rounded-full", track.kind === "midi" ? "bg-sky-500/60" : "bg-emerald-500/60")} style={{ height: `${Math.min(24, height / 2)}px` }} />
                          ))}
                        </span>
                        {track.kind === "midi" && <span className="absolute bottom-1 left-1 font-mono text-[8px] text-sky-700">MIDI CLIP · {section.name}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
              <div className="relative h-9 border-b bg-orange-500/[0.03]">
                {sections.map((section) => (
                  <div key={section.name} className="absolute inset-y-1" style={{ left: `${((section.startBar - 1) / barCount) * 100}%`, width: `${((section.endBar - section.startBar + 1) / barCount) * 100}%` }}>
                    <svg className="h-full w-full overflow-visible" preserveAspectRatio="none" viewBox="0 0 100 100">
                      <polyline points={section.automation.map((point: AutomationPoint) => `${((point.bar - section.startBar) / Math.max(1, section.endBar - section.startBar)) * 100},${100 - point.value * 80}`).join(" ")} fill="none" stroke="#f97316" strokeWidth="3" vectorEffect="non-scaling-stroke" />
                    </svg>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid min-h-0 gap-3 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="overflow-hidden border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between border-b px-4 py-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              {detailPanel === "piano" ? <Pencil className="h-4 w-4 text-sky-500" /> : <Music2 className="h-4 w-4 text-violet-500" />}
              {detailPanel === "piano" ? `Piano roll · ${selectedTrackName}` : "Chord track"}
              {selectedSection && <Badge variant="secondary" className="ml-1 text-[10px]">{selectedSection.name}</Badge>}
            </CardTitle>
            <div className="flex items-center gap-1">
              {detailPanel && <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setDetailPanel(null)}><X className="h-3.5 w-3.5" /></Button>}
              <Button variant="outline" size="sm" className="h-7 gap-1 text-[10px]" onClick={() => setDetailPanel(detailPanel === "piano" ? "chord" : "piano")}>
                <GitBranch className="h-3 w-3" /> switch editor
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {detailPanel === "piano" ? (
              <div className="min-h-[236px]">
                <div className="flex items-center gap-1 border-b bg-muted/20 px-3 py-2">
                  {[
                    ["quantize", "Quantize"],
                    ["humanize", "Humanize"],
                    ["move", "Move +snap"],
                    ["transpose", "Transpose"],
                    ["duplicate", "Duplicate"],
                    ["resize", "Resize"],
                  ].map(([operation, label]) => (
                    <Button key={operation} variant="ghost" size="sm" className="h-7 px-2 text-[10px]" onClick={() => applyNoteOperation(operation as "quantize" | "humanize" | "transpose" | "duplicate" | "resize" | "move")}>{label}</Button>
                  ))}
                  <Button variant="ghost" size="icon" className="ml-auto h-7 w-7 text-destructive" disabled={!selectedNote} onClick={() => selectedNote && updateNotes((current) => current.filter((note) => note.id !== selectedNote.id))}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
                {selectedNote && (
                  <div className="grid grid-cols-[1fr_130px] items-center gap-3 border-b px-3 py-2">
                    <div className="flex items-center gap-2"><Badge variant="outline" className="font-mono text-[8px]">{selectedNote.id}</Badge><Label className="w-14 text-[9px] uppercase text-muted-foreground">Velocity</Label><Slider value={[selectedNote.velocity]} min={1} max={127} step={1} onValueChange={([velocity]) => updateNotes((current) => current.map((note) => note.id === selectedNote.id ? { ...note, velocity } : note))} /><span className="w-7 font-mono text-[9px]">{selectedNote.velocity}</span></div>
                    <Select value={selectedNote.articulation} onValueChange={(value) => updateNotes((current) => current.map((note) => note.id === selectedNote.id ? { ...note, articulation: value as PianoNote["articulation"] } : note))}><SelectTrigger className="h-7 text-[10px]"><SelectValue /></SelectTrigger><SelectContent>{["sustain", "staccato", "accent", "ghost"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select>
                  </div>
                )}
                <div className="flex h-[178px]">
                  <div className="w-12 shrink-0 border-r bg-muted/30">
                    {PITCHES.map((pitch, index) => <div key={pitch} className={cn("h-[13.6px] border-b px-1 font-mono text-[8px]", pitch.includes("#") ? "bg-foreground text-background" : "bg-card text-muted-foreground")}>{index % 2 === 0 ? pitch : ""}</div>)}
                  </div>
                  <div
                    className="relative flex-1 overflow-hidden bg-[linear-gradient(to_right,hsl(var(--border)/.55)_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border)/.45)_1px,transparent_1px)]"
                    style={{ backgroundSize: `${100 / selectedSectionBeatCount}% 100%, 100% 13.6px` }}
                    onClick={handlePianoGridClick}
                  >
                    {notes.map((note) => {
                      const row = SCALE_PITCHES.length - 1 - SCALE_PITCHES.indexOf(note.pitch);
                      const pitchRow = row < 0 ? Math.abs(note.pitch - 60) % PITCHES.length : row;
                      return (
                        <button
                          type="button"
                          key={note.id}
                          aria-label={`Note ${note.id} pitch ${note.pitch} beat ${note.start + 1}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (tool === "erase") {
                              updateNotes((current) => current.filter((candidate) => candidate.id !== note.id));
                              return;
                            }
                            if (tool === "split") {
                              splitNote(note);
                              return;
                            }
                            setSelectedNoteId(note.id);
                            setDetailPanel("piano");
                            onSelectionChange({ kind: "note", trackName: selectedTrackName, sectionName: selectedSection?.name ?? "Section", startBar: selectedSection?.startBar ?? 1, endBar: selectedSection?.endBar ?? 8 });
                          }}
                          className={cn("absolute h-3 rounded-sm border px-1 text-left text-[8px] font-semibold text-sky-950 shadow-sm", selectedNoteId === note.id ? "border-primary bg-sky-400 ring-1 ring-primary" : "border-sky-500/50 bg-sky-400/80")}
                          style={{ left: `${(note.start / selectedSectionBeatCount) * 100}%`, top: `${Math.max(0, Math.min(PITCHES.length - 1, pitchRow)) * 13.6}px`, width: `${Math.max(1.5, (note.duration / selectedSectionBeatCount) * 100)}%` }}
                        >
                          {note.articulation === "accent" ? ">" : ""}
                        </button>
                      );
                    })}
                    {tool === "draw" && <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded border border-dashed border-primary/50 text-[10px] text-primary">click to draw note</div>}
                  </div>
                </div>
                <div className="flex border-t bg-muted/20">
                  <div className="w-12 shrink-0 px-1 py-1 font-mono text-[8px] text-muted-foreground">VEL</div>
                  <div className="flex h-8 flex-1 items-end gap-1 px-2">
                    {ccPoints.map((point, index) => <button type="button" key={index} title={`CC1 ${point}`} onClick={() => updateCcPoint(index)} className="flex-1 rounded-t bg-violet-400/70 hover:bg-violet-500" style={{ height: `${Math.max(10, point / 4)}px` }} />)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4">
                {selectedChord ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-[1fr_130px_130px]">
                      <div><Label className="text-[10px] uppercase text-muted-foreground">Symbol</Label><Input className="mt-1 h-9 font-mono" value={selectedChord.symbol} onChange={(event) => updateSelectedChord({ symbol: event.target.value })} /></div>
                      <div><Label className="text-[10px] uppercase text-muted-foreground">Quality</Label><Select value={selectedChord.quality} onValueChange={(value) => updateSelectedChord({ quality: value as ChordEvent["quality"] })}><SelectTrigger className="mt-1 h-9 text-xs"><SelectValue /></SelectTrigger><SelectContent>{["major", "minor", "dominant", "suspended", "diminished"].map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></div>
                      <div><Label className="text-[10px] uppercase text-muted-foreground">Inversion</Label><Select value={String(selectedChord.inversion)} onValueChange={(value) => updateSelectedChord({ inversion: Number(value) })}><SelectTrigger className="mt-1 h-9 text-xs"><SelectValue /></SelectTrigger><SelectContent>{[0, 1, 2].map((value) => <SelectItem key={value} value={String(value)}>Root position {value}</SelectItem>)}</SelectContent></Select></div>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {[
                        ["reharmonize", "Reharmonize", Wand2],
                        ["simplify", "Simplify", SlidersHorizontal],
                        ["richen", "Richen", Sparkles],
                        ["invert", "Invert", ArrowUp],
                        ["bass", "Set bass", ArrowDown],
                        ["alternative", "Alternatives", GitBranch],
                      ].map(([action, label, Icon]) => <Button key={action as string} variant="outline" size="sm" className="h-8 gap-1.5 text-[10px]" onClick={() => applyChordAction(action as "reharmonize" | "simplify" | "richen" | "invert" | "bass" | "alternative")}><Icon className="h-3 w-3" />{label as string}</Button>)}
                    </div>
                    <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{selectedChord.symbol}</span> is scoped to beat {selectedChord.startBeat + 1} and edits only <span className="font-semibold text-foreground">{selectedSection?.name}</span>. Choose an alternative to compare voicings without regenerating the arrangement.
                    </div>
                    <div className="mt-3 space-y-3 rounded-lg border p-3" data-testid="chord-decision-evidence">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Why this chord</div>
                        <div className="flex items-center gap-1.5">
                          {selectedChordEvidence && selectedChordEvidence.symbol !== selectedChord.symbol && (
                            <Badge variant="outline" className="text-[10px]">evidence for {selectedChordEvidence.symbol}</Badge>
                          )}
                          {selectedChordEvidence?.function
                            ? <Badge variant="secondary" className="text-[10px]">{selectedChordEvidence.function}</Badge>
                            : <span className="text-[10px] italic text-muted-foreground">Function not recorded</span>}
                        </div>
                      </div>
                      {selectedChordEvidence ? (
                        <>
                          {selectedChordEvidence.symbol !== selectedChord.symbol && (
                            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-800 dark:text-amber-300">
                              This evidence explains the analyzed {selectedChordEvidence.symbol}, not the edited {selectedChord.symbol}. No rationale has been recorded for the edit yet.
                            </div>
                          )}
                          <div className="grid gap-2 text-xs sm:grid-cols-3">
                            <div className="rounded border bg-muted/20 p-2">
                              <div className="text-[9px] uppercase text-muted-foreground">Analysis</div>
                              <div className="mt-1 font-medium">{selectedChordEvidence.roman || "Roman numeral not recorded"}</div>
                              <div className="mt-0.5 text-[10px] text-muted-foreground">
                                {Math.round(selectedChordEvidence.confidence * 100)}% confidence
                                {selectedChordEvidence.bass ? ` · bass ${selectedChordEvidence.bass}` : " · bass not recorded"}
                              </div>
                            </div>
                            <div className="rounded border bg-muted/20 p-2 sm:col-span-2">
                              <div className="text-[9px] uppercase text-muted-foreground">Supporting evidence</div>
                              {selectedChordEvidence.candidateProvenance?.some((candidate) => candidate.evidence?.length) ? (
                                <ul className="mt-1 space-y-1 text-[10px] text-muted-foreground">
                                  {selectedChordEvidence.candidateProvenance.flatMap((candidate) =>
                                    (candidate.evidence ?? []).map((evidence) => (
                                      <li key={`${candidate.candidateId}-${evidence}`}>
                                        <span className="font-medium text-foreground">{candidate.provider}:</span> {evidence}
                                      </li>
                                    )))}
                                </ul>
                              ) : <div className="mt-1 text-[10px] italic text-muted-foreground">No supporting evidence was recorded.</div>}
                            </div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-muted-foreground">Observed bass support</div>
                            {selectedChordEvidence.bassSupportEvidence?.length ? (
                              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                                {selectedChordEvidence.bassSupportEvidence.map((evidence, index) => (
                                  <div key={`${evidence.provider}-${evidence.start}-${evidence.pitch}-${index}`} className="rounded border px-2 py-1.5 text-[10px]">
                                    <span className="font-medium">{evidence.provider}</span>
                                    <span className="text-muted-foreground"> observed MIDI {evidence.pitch} · {evidence.start.toFixed(2)}–{evidence.end.toFixed(2)}s · {Math.round(evidence.confidence * 100)}% confidence</span>
                                  </div>
                                ))}
                              </div>
                            ) : <div className="mt-1 text-[10px] italic text-muted-foreground">No provider bass observation supported this chord.</div>}
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-muted-foreground">Melody conflicts</div>
                            {selectedChordEvidence.melodyConflictEvidence?.length ? (
                              <div className="mt-1 flex flex-wrap gap-1.5">
                                {selectedChordEvidence.melodyConflictEvidence.map((conflict, index) => (
                                  <Badge key={`${conflict.noteId ?? conflict.pitch ?? index}-${conflict.conflict}`} variant="outline" className="h-auto whitespace-normal py-1 text-[10px]">
                                    {typeof conflict.conflict === "string" ? conflict.conflict.replaceAll("_", " ") : "unknown conflict"}
                                    {typeof conflict.severity === "number" && Number.isFinite(conflict.severity) ? ` · ${Math.round(conflict.severity * 100)}%` : ""}
                                    {typeof conflict.explanation === "string" && conflict.explanation ? ` · ${conflict.explanation}` : ""}
                                  </Badge>
                                ))}
                              </div>
                            ) : <div className="mt-1 text-[10px] italic text-muted-foreground">No melody conflicts were recorded.</div>}
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-muted-foreground">Candidate rationale</div>
                            {selectedChordEvidence.candidateProvenance?.length ? (
                              <div className="mt-1 space-y-1">
                                {selectedChordEvidence.candidateProvenance.map((candidate) => (
                                  <div key={candidate.candidateId} className="flex items-center gap-2 rounded border px-2 py-1.5 text-[10px]">
                                    <Badge variant={candidate.selected ? "default" : "outline"} className="text-[9px]">{candidate.selected ? "selected" : "considered"}</Badge>
                                    <span className="font-medium">{candidate.provider}</span>
                                    <span className="text-muted-foreground">{typeof candidate.score === "number" && Number.isFinite(candidate.score) ? `score ${candidate.score.toFixed(2)}` : "score not recorded"}</span>
                                    <span className="ml-auto truncate text-muted-foreground">{candidate.modelVersion ?? "model version not recorded"}</span>
                                  </div>
                                ))}
                              </div>
                            ) : <div className="mt-1 text-[10px] italic text-muted-foreground">No candidate rationale was recorded.</div>}
                          </div>
                        </>
                      ) : selectedHarmonyDecision ? (
                        <div className="space-y-3" data-testid="deterministic-harmony-evidence">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline">engine choice</Badge>
                            <span className="font-medium">{selectedHarmonyDecision.function ?? selectedHarmonyDecision.symbol}</span>
                            {selectedHarmonyDecision.symbol !== selectedChord.symbol && (
                              <span className="text-[10px] text-muted-foreground">recorded for {selectedHarmonyDecision.symbol}; editor currently shows {selectedChord.symbol}</span>
                            )}
                          </div>
                          <div className="grid gap-2 text-[10px] sm:grid-cols-4">
                            <div className="rounded border p-2"><div className="text-muted-foreground">Melody fit</div><div className="mt-1 font-mono">{selectedHarmonyDecision.melodyFit !== undefined ? `${Math.round(selectedHarmonyDecision.melodyFit * 100)}%` : "not scored"}</div></div>
                            <div className="rounded border p-2"><div className="text-muted-foreground">Bass fit</div><div className="mt-1 font-mono">{selectedHarmonyDecision.bassFit !== undefined ? `${Math.round(selectedHarmonyDecision.bassFit * 100)}%` : "not scored"}</div></div>
                            <div className="rounded border p-2"><div className="text-muted-foreground">Voice leading</div><div className="mt-1 font-mono">{selectedHarmonyDecision.voiceLeading !== undefined ? selectedHarmonyDecision.voiceLeading.toFixed(2) : "not scored"}</div></div>
                            <div className="rounded border p-2"><div className="text-muted-foreground">Total score</div><div className="mt-1 font-mono">{selectedHarmonyDecision.score !== undefined ? selectedHarmonyDecision.score.toFixed(2) : "not scored"}</div></div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase text-muted-foreground">Candidate rationale</div>
                            {selectedHarmonyDecision.candidateRationale?.length ? (
                              <div className="mt-1 space-y-1">
                                {selectedHarmonyDecision.candidateRationale.map((candidate) => (
                                  <div key={`${candidate.symbol}-${candidate.score}`} className="flex items-center gap-2 rounded border px-2 py-1.5 text-[10px]">
                                    <Badge variant={candidate.selected ? "default" : "outline"} className="text-[9px]">{candidate.selected ? "selected" : "considered"}</Badge>
                                    <span className="font-medium">{candidate.function}</span>
                                    <span className="text-muted-foreground">score {candidate.score.toFixed(2)}</span>
                                    <span className="ml-auto text-muted-foreground">melody {Math.round(candidate.melodyFit * 100)}% · bass {Math.round(candidate.bassFit * 100)}%</span>
                                  </div>
                                ))}
                              </div>
                            ) : <div className="mt-1 text-[10px] italic text-muted-foreground">No alternatives were recorded.</div>}
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs italic text-muted-foreground">No analysis evidence is linked to this chord. Its reason cannot be shown without inferring one.</div>
                      )}
                    </div>
                  </>
                ) : <div className="flex min-h-[160px] flex-col items-center justify-center text-center text-sm text-muted-foreground"><Music2 className="mb-2 h-8 w-8 opacity-30" />Select a chord block to edit its harmony.</div>}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border shadow-sm">
          <CardHeader className="border-b px-4 py-3"><CardTitle className="flex items-center gap-2 text-sm"><SlidersHorizontal className="h-4 w-4 text-orange-500" />Semantic conductor</CardTitle></CardHeader>
          <CardContent className="space-y-4 p-4">
            {selectedSection ? (
              <>
                <div className="flex items-center justify-between"><div><div className="text-sm font-semibold">{selectedSection.name}</div><div className="font-mono text-[10px] text-muted-foreground">bars {selectedSection.startBar}–{selectedSection.endBar}</div></div><Badge variant="outline" className="text-[10px]">local scope</Badge></div>
                <div className="flex items-center justify-between rounded-md border bg-muted/20 px-2 py-1.5 text-[10px]"><span>Harmonic shift</span><span className="font-mono">{selectedSection.transposeSemitones > 0 ? "+" : ""}{selectedSection.transposeSemitones} semitones</span></div>
                <div><Label className="flex justify-between text-[10px] uppercase text-muted-foreground"><span>Energy</span><span className="font-mono text-foreground">{Math.round(selectedSection.energy * 100)}%</span></Label><Slider className="mt-2" value={[selectedSection.energy]} min={0} max={1} step={0.01} onValueChange={([value]) => updateSelectedSection({ energy: value, automation: selectedSection.automation.map((point) => ({ ...point, value })) })} /></div>
                <div><Label className="flex justify-between text-[10px] uppercase text-muted-foreground"><span>Density</span><span className="font-mono text-foreground">{Math.round(selectedSection.density * 100)}%</span></Label><Slider className="mt-2" value={[selectedSection.density]} min={0} max={1} step={0.01} onValueChange={([value]) => updateSelectedSection({ density: value })} /></div>
                <div className="border-t pt-3"><div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Track activation</div><div className="flex flex-wrap gap-1.5">{tracks.map((track) => <button type="button" key={track.id} onClick={() => toggleTrackInSection(track.name)} className={cn("rounded border px-2 py-1 text-[10px] transition-colors", selectedSection.tracks.includes(track.name) || !selectedSection.tracks.length ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}>{track.name}</button>)}</div></div>
                <div className="flex gap-2 border-t pt-3"><Button variant="outline" size="sm" className="h-8 flex-1 gap-1 text-[10px]" onClick={() => updateSelectedSection({ automation: [...selectedSection.automation, { bar: Math.min(selectedSection.endBar, selectedSection.startBar + 4), value: Math.min(1, selectedSection.energy + 0.12) }] })}><Plus className="h-3 w-3" /> Add envelope point</Button><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setOpenAutomation((current) => ({ ...current, [selectedSection.name]: !current[selectedSection.name] }))}>{openAutomation[selectedSection.name] ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</Button></div>
                {openAutomation[selectedSection.name] && <div className="rounded border bg-muted/20 p-2 font-mono text-[10px] text-muted-foreground">{selectedSection.automation.map((point, index) => <div className="flex justify-between py-0.5" key={`${point.bar}-${index}`}><span>bar {point.bar}</span><span>{Math.round(point.value * 100)}%</span></div>)}</div>}
              </>
            ) : <div className="py-8 text-center text-xs text-muted-foreground">Select a section to direct its musical intent.</div>}
          </CardContent>
        </Card>
      </div>
      </div>

      {showHistory && (
        <div className="absolute right-0 top-0 bottom-0 w-[min(20rem,calc(100%-1rem))] bg-card/95 backdrop-blur-md border-l shadow-[-8px_0_24px_rgba(0,0,0,0.08)] z-30 flex flex-col rounded-l-xl overflow-hidden flex-shrink-0 animate-in slide-in-from-right-8 duration-200">
          <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/40">
            <h3 className="font-semibold text-sm flex items-center gap-2"><History className="h-4 w-4" /> Revision History</h3>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { cancelPreview(); setShowHistory(false); }}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <ScrollArea className="flex-1">
            {isLoadingRevisions ? (
              <div className="p-4 space-y-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="space-y-2">
                    <div className="flex justify-between"><div className="h-4 w-12 bg-muted rounded animate-pulse" /><div className="h-4 w-20 bg-muted rounded animate-pulse" /></div>
                    <div className="h-8 w-full bg-muted/50 rounded animate-pulse" />
                  </div>
                ))}
              </div>
            ) : revisions?.length ? (
              <div className="flex flex-col">
                {revisions.map((rev) => {
                  const isCurrent = rev.version === arrangement?.version;
                  const isPreviewing = previewRevisionId === rev.id;
                  const comparison = arrangement
                    ? revisionControlComparison(rev, arrangement)
                    : null;
                  return (
                    <div
                      key={rev.id}
                      className={cn(
                        "p-4 border-b flex flex-col gap-3 transition-all relative overflow-hidden group",
                        !isCurrent && "cursor-pointer",
                        isPreviewing ? "bg-primary/5 border-primary/30 shadow-[inset_2px_0_0_hsl(var(--primary))]" : isCurrent ? "bg-muted/20" : "hover:bg-muted/40 hover:shadow-[inset_2px_0_0_hsl(var(--muted-foreground)/0.3)]"
                      )}
                      onClick={() => !isCurrent && startPreview(rev)}
                    >
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <span className={cn("font-bold text-sm", isPreviewing && "text-primary")}>v{rev.version}</span>
                          {isCurrent && <Badge variant="outline" className="text-[9px] h-4 py-0 font-normal uppercase tracking-wider bg-background">Current</Badge>}
                        </div>
                        <span className="text-[10px] text-muted-foreground">{new Date(rev.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {rev.summary.affectedSections?.length > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            Sec: {rev.summary.affectedSections.join(', ')}
                          </Badge>
                        )}
                        {rev.summary.affectedTracks?.length > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            Trk: {rev.summary.affectedTracks.join(', ')}
                          </Badge>
                        )}
                        {rev.summary.chordChanges > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            {rev.summary.chordChanges} chords
                          </Badge>
                        )}
                        {rev.summary.noteChanges > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            {rev.summary.noteChanges} notes
                          </Badge>
                        )}
                        {rev.summary.ccChanges > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            {rev.summary.ccChanges} CC values
                          </Badge>
                        )}
                        {rev.summary.trackMembershipChanges > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            {rev.summary.trackMembershipChanges} track {rev.summary.trackMembershipChanges === 1 ? "membership" : "memberships"}
                          </Badge>
                        )}
                        {rev.summary.conductorControls?.length > 0 && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            {rev.summary.conductorControls.join(', ')}
                          </Badge>
                        )}
                        {rev.summary.candidateSelectionChanged && (
                          <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 font-normal bg-background/50 border-muted-foreground/20 text-muted-foreground">
                            Candidate selection
                          </Badge>
                        )}
                      </div>

                      {isPreviewing && (
                        <div className="mt-1 pt-3 border-t border-primary/20 flex flex-col gap-2.5 animate-in fade-in zoom-in-95 duration-200">
                          <div className="rounded-md border border-primary/20 bg-background/70 p-2.5">
                            <div className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Compared with current v{arrangement?.version}
                            </div>
                            <div className="mt-2 space-y-1.5 text-[10px]">
                              <div className="flex items-start justify-between gap-3">
                                <span className="text-muted-foreground">Sections</span>
                                <span className="text-right font-medium">
                                  {comparison?.affectedSections.length
                                    ? comparison.affectedSections.join(", ")
                                    : "No section differences"}
                                </span>
                              </div>
                              {comparison?.controls.map((control) => (
                                <div className="flex items-center justify-between gap-3" key={control.label}>
                                  <span className="text-muted-foreground">{control.label}</span>
                                  <span className="font-mono">
                                    v{rev.version} {control.revision} → current {control.current}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="text-[10px] text-primary/80 leading-snug">
                            Restoring will append a new version (v{(arrangement?.version ?? 0) + 1}) to your history. No revisions are deleted.
                          </div>
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); handleRestore(rev); }}
                              className="flex-1 h-7 text-[10px] font-semibold bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
                              disabled={restoreMutation.isPending}
                            >
                              {restoreMutation.isPending ? "Restoring..." : `Restore to v${rev.version}`}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No revisions found.
              </div>
            )}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
