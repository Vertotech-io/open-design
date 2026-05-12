import { useEffect, useRef, useState } from 'react';
import { emptyManualEditStyles, type ManualEditHistoryEntry, type ManualEditPatch, type ManualEditStyles, type ManualEditTarget } from '../edit-mode/types';

export interface ManualEditDraft {
  text: string;
  href: string;
  src: string;
  alt: string;
  styles: ManualEditStyles;
  attributesText: string;
  outerHtml: string;
  fullSource: string;
}

export function emptyManualEditDraft(source = ''): ManualEditDraft {
  return {
    text: '', href: '', src: '', alt: '',
    styles: emptyManualEditStyles(),
    attributesText: '{}', outerHtml: '', fullSource: source,
  };
}

export function ManualEditPanel({
  selectedTarget,
  draft,
  error,
  onDraftChange,
  onPreviewStyle,
  onApplyPatch,
}: {
  targets: ManualEditTarget[];
  selectedTarget: ManualEditTarget | null;
  draft: ManualEditDraft;
  history: ManualEditHistoryEntry[];
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  busy?: boolean;
  onSelectTarget: (target: ManualEditTarget) => void;
  onDraftChange: (draft: ManualEditDraft) => void;
  onPreviewStyle?: (id: string, styles: Partial<ManualEditStyles>) => void;
  onApplyPatch: (patch: ManualEditPatch, label: string) => void;
  onError: (message: string) => void;
  onCancelDraft: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  // Live preview: every style change goes to the iframe via postMessage so the
  // canvas updates instantly without an iframe reload. The 1.5s debounced
  // source-rewrite still happens via onApplyPatch for persistence.
  const lastPreviewedRef = useRef<string>('');
  const lastAppliedRef = useRef<string>('');
  const lastTargetIdRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!selectedTarget) {
      lastTargetIdRef.current = null;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    const key = JSON.stringify(draft.styles);
    if (lastTargetIdRef.current !== selectedTarget.id) {
      lastTargetIdRef.current = selectedTarget.id;
      lastPreviewedRef.current = key;
      lastAppliedRef.current = key;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    if (key !== lastPreviewedRef.current) {
      lastPreviewedRef.current = key;
      onPreviewStyle?.(selectedTarget.id, draft.styles);
    }
    if (key === lastAppliedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (key === lastAppliedRef.current) return;
      lastAppliedRef.current = key;
      onApplyPatch({ id: selectedTarget.id, kind: 'set-style', styles: draft.styles }, `Style: ${selectedTarget.label}`);
    }, 1500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [draft.styles, selectedTarget?.id, onPreviewStyle, onApplyPatch]);

  const targetForInspector = selectedTarget;

  return (
    <aside className="manual-edit-right">
      <section className="manual-edit-modal cc-panel">
        {targetForInspector ? (
          <StyleInspector
            styles={draft.styles}
            onChange={(styles) => onDraftChange({ ...draft, styles })}
          />
        ) : !targetForInspector ? (
          <PageInspector onPreviewStyle={onPreviewStyle} onApplyPatch={onApplyPatch} />
        ) : null}

        {error ? <div className="manual-edit-error">{error}</div> : null}
      </section>
    </aside>
  );
}

function PageInspector({
  onPreviewStyle, onApplyPatch,
}: {
  onPreviewStyle?: (id: string, styles: Partial<ManualEditStyles>) => void;
  onApplyPatch: (patch: ManualEditPatch, label: string) => void;
}) {
  const [bg, setBg] = useState('');
  const [font, setFont] = useState('');
  const [size, setSize] = useState('');
  const initializedRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedRef = useRef<string>('');

  useEffect(() => {
    const styles: Partial<ManualEditStyles> = {
      backgroundColor: bg,
      fontFamily: font,
      fontSize: size ? (/^\d+(\.\d+)?$/.test(size.trim()) ? `${size.trim()}px` : size.trim()) : '',
    };
    const key = JSON.stringify(styles);
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastAppliedRef.current = key;
      return;
    }
    onPreviewStyle?.('__body__', styles);
    if (key === lastAppliedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      lastAppliedRef.current = key;
      onApplyPatch({ id: '__body__', kind: 'set-style', styles }, 'Page styles');
    }, 1500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bg, font, size]);

  return (
    <div className="cc-inspector">
      <Section title="PAGE">
        <ColorRow label="Background" value={bg} onChange={setBg} />
        <FontRow value={font} onChange={setFont} />
        <UnitRow label="Base size" value={size} onChange={setSize} unit="px" />
      </Section>
    </div>
  );
}

const FONT_OPTS = [
  { label: 'inherit', value: '' },
  { label: 'Space Grotesk', value: '"Space Grotesk", Inter, system-ui, sans-serif' },
  { label: 'Inter', value: 'Inter, system-ui, sans-serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Roboto', value: 'Roboto, Arial, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'monospace', value: 'SFMono-Regular, Consolas, "Liberation Mono", monospace' },
] as const;
const WEIGHT_OPTS = ['', '100', '200', '300', '400', '500', '600', '700', '800', '900'];
const ALIGN_OPTS = ['', 'left', 'center', 'right', 'justify', 'start', 'end'];
const DIRECTION_OPTS = ['', 'row', 'column', 'row-reverse', 'column-reverse'];
const JUSTIFY_OPTS = ['', 'flex-start', 'center', 'flex-end', 'space-between', 'space-around'];
const ITEMS_OPTS = ['', 'stretch', 'flex-start', 'center', 'flex-end', 'baseline'];
const BORDER_STYLE_OPTS = ['', 'solid', 'dashed', 'dotted', 'double', 'none'];
const EDITOR_SWATCH_COLORS = [
  '#000000',
  '#ffffff',
  '#374151',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

function StyleInspector({
  styles, onChange,
}: {
  styles: ManualEditStyles;
  onChange: (styles: ManualEditStyles) => void;
}) {
  const u = (key: keyof ManualEditStyles, value: string) => onChange({ ...styles, [key]: value });

  return (
    <div className="cc-inspector">
      <Section title="TYPOGRAPHY">
        <FontRow value={styles.fontFamily} onChange={(v) => u('fontFamily', v)} />
        <PairRow>
          <UnitRow label="Size" value={styles.fontSize} onChange={(v) => u('fontSize', v)} unit="px" autoUnit />
          <DropdownRow label="Weight" value={styles.fontWeight} onChange={(v) => u('fontWeight', v)} options={WEIGHT_OPTS} />
        </PairRow>
        <PairRow>
          <ColorRow label="Color" value={styles.color} onChange={(v) => u('color', v)} />
          <DropdownRow label="Align" value={styles.textAlign} onChange={(v) => u('textAlign', v)} options={ALIGN_OPTS} />
        </PairRow>
        <PairRow>
          <UnitRow label="Line" value={styles.lineHeight} onChange={(v) => u('lineHeight', v)} unit="" />
          <UnitRow label="Tracking" value={styles.letterSpacing} onChange={(v) => u('letterSpacing', v)} unit="px" autoUnit />
        </PairRow>
      </Section>

      <Section title="SIZE">
        <PairRow>
          <UnitRow label="Width" value={styles.width} onChange={(v) => u('width', v)} unit="px" autoUnit />
          <UnitRow label="Height" value={styles.height} onChange={(v) => u('height', v)} unit="px" autoUnit />
        </PairRow>
      </Section>

      <Section title="LAYOUT">
        <PairRow>
          <UnitRow label="Gap" value={styles.gap} onChange={(v) => u('gap', v)} unit="px" autoUnit />
          <DropdownRow label="Direction" value={styles.flexDirection} onChange={(v) => u('flexDirection', v)} options={DIRECTION_OPTS} />
        </PairRow>
        <PairRow>
          <DropdownRow label="Justify" value={styles.justifyContent} onChange={(v) => u('justifyContent', v)} options={JUSTIFY_OPTS} />
          <DropdownRow label="Align" value={styles.alignItems} onChange={(v) => u('alignItems', v)} options={ITEMS_OPTS} />
        </PairRow>
      </Section>

      <Section title="BOX">
        <PairRow>
          <ColorRow label="Fill" value={styles.backgroundColor} onChange={(v) => u('backgroundColor', v)} />
          <UnitRow label="Opacity" value={styles.opacity} onChange={(v) => u('opacity', v)} unit="" />
        </PairRow>

        <QuadRow label="Padding" values={{
          t: styles.paddingTop, r: styles.paddingRight, b: styles.paddingBottom, l: styles.paddingLeft,
        }} onChange={(side, value) => u(sideToProp('padding', side), value)} />

        <QuadRow label="Margin" values={{
          t: styles.marginTop, r: styles.marginRight, b: styles.marginBottom, l: styles.marginLeft,
        }} onChange={(side, value) => u(sideToProp('margin', side), value)} />

        <QuadRow label="Border" values={{
          t: styles.borderTopWidth, r: styles.borderRightWidth, b: styles.borderBottomWidth, l: styles.borderLeftWidth,
        }} onChange={(side, value) => u(`border${sideUpper(side)}Width` as keyof ManualEditStyles, value)} />

        <PairRow>
          <DropdownRow label="Style" value={styles.borderStyle} onChange={(v) => u('borderStyle', v)} options={BORDER_STYLE_OPTS} />
          <ColorRow label="Border" value={styles.borderColor} onChange={(v) => u('borderColor', v)} compact />
        </PairRow>
        <UnitRow label="Radius" value={styles.borderRadius} onChange={(v) => u('borderRadius', v)} unit="px" autoUnit />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="cc-section">
      <header className="cc-section-head">{title}</header>
      <div className="cc-section-body">{children}</div>
    </section>
  );
}

function PairRow({ children }: { children: React.ReactNode }) {
  return <div className="cc-pair">{children}</div>;
}

function UnitRow({ label, value, onChange, unit, autoUnit }: {
  label: string; value: string; onChange: (v: string) => void;
  unit: string; autoUnit?: boolean;
}) {
  const display = value;
  const handle = (raw: string) => {
    const trimmed = raw.trim();
    if (autoUnit && trimmed && /^-?\d+(\.\d+)?$/.test(trimmed)) onChange(`${trimmed}px`);
    else onChange(raw);
  };
  return (
    <label className="cc-row">
      <span className="cc-label">{label}</span>
      <span className="cc-value">
        <input value={display} placeholder="" onChange={(e) => onChange(e.currentTarget.value)} onBlur={(e) => handle(e.currentTarget.value)} />
        {unit ? <em className="cc-unit">{unit}</em> : null}
      </span>
    </label>
  );
}

function DropdownRow({ label, value, onChange, options, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  options: ReadonlyArray<string>; placeholder?: string;
}) {
  return (
    <label className="cc-row">
      <span className="cc-label">{label}</span>
      <span className="cc-value cc-select">
        <select value={value} onChange={(e) => onChange(e.currentTarget.value)}>
          {!options.includes(value) && value ? <option value={value}>{value}</option> : null}
          {options.map((opt) => <option key={opt || '__'} value={opt}>{opt || (placeholder ?? '–')}</option>)}
        </select>
        <em className="cc-chevron">▾</em>
      </span>
    </label>
  );
}

function FontRow({ value, onChange }: {
  value: string;
  onChange: (v: string) => void;
}) {
  const normalizedValue = normalizeFontFamilyForSelect(value);
  const customValue = normalizedValue === value ? value : '';
  return (
    <label className="cc-row">
      <span className="cc-label">Font</span>
      <span className="cc-value cc-select">
        <select value={normalizedValue} onChange={(event) => onChange(event.currentTarget.value)}>
          {customValue && !FONT_OPTS.some((option) => option.value === customValue) ? (
            <option value={customValue}>{fontFamilyLabel(customValue)}</option>
          ) : null}
          {FONT_OPTS.map((option) => (
            <option key={option.label} value={option.value}>{option.label}</option>
          ))}
        </select>
        <em className="cc-chevron">▾</em>
      </span>
    </label>
  );
}

function normalizeFontFamilyForSelect(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const direct = FONT_OPTS.find((option) => option.value === trimmed);
  if (direct) return direct.value;
  const families = parseFontFamilies(trimmed);
  const primaryFamily = families[0];
  const match = FONT_OPTS.find((option) => {
    if (!option.value) return false;
    const optionFamilies = parseFontFamilies(option.value);
    return optionFamilies[0] === primaryFamily;
  });
  return match?.value ?? trimmed;
}

function fontFamilyLabel(value: string): string {
  return parseFontFamilies(value)[0] ?? value;
}

function parseFontFamilies(value: string): string[] {
  return value
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);
}

function ColorRow({ label, value, onChange, compact }: {
  label: string; value: string; onChange: (v: string) => void; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);
  return (
    <label className="cc-row">
      {compact ? null : <span className="cc-label">{label}</span>}
      <span className={`cc-value cc-color ${compact ? 'cc-color-compact' : ''}`} ref={ref}>
        <button type="button" className="cc-swatch" style={{ background: value || 'transparent' }}
          onClick={() => setOpen((v) => !v)} aria-label={`Pick ${label}`} />
        <input value={value} placeholder="#000000"
          onChange={(e) => onChange(e.currentTarget.value)} onFocus={() => setOpen(true)} />
        {open ? (
          <div className="cc-color-popover">
            <div className="cc-color-grid">
              {EDITOR_SWATCH_COLORS.map((hex) => (
                <button key={hex} type="button" className="cc-color-tile" style={{ background: hex }}
                  onClick={() => { onChange(hex); setOpen(false); }} aria-label={hex} />
              ))}
            </div>
            <input type="color" className="cc-color-native" value={normalizeColorForPicker(value)}
              onChange={(e) => onChange(e.currentTarget.value)} />
          </div>
        ) : null}
      </span>
    </label>
  );
}

function QuadRow({ label, values, onChange }: {
  label: string; values: { t: string; r: string; b: string; l: string };
  onChange: (side: 't' | 'r' | 'b' | 'l', value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const allEqualValue = (() => {
    const v = values.t;
    return v === values.r && v === values.b && v === values.l ? v : null;
  })();
  return (
    <div className="cc-quad">
      <button type="button" className="cc-quad-head" onClick={() => setOpen((v) => !v)}>
        <span>{label}</span>
        {!open && allEqualValue !== null ? <em>{allEqualValue || '0 px'}</em> : <span className="cc-chevron-small">{open ? '▾' : '▸'}</span>}
      </button>
      {open ? (
        <div className="cc-quad-grid">
          <QuadCell axis="T" value={values.t} onChange={(v) => onChange('t', v)} />
          <QuadCell axis="R" value={values.r} onChange={(v) => onChange('r', v)} />
          <QuadCell axis="B" value={values.b} onChange={(v) => onChange('b', v)} />
          <QuadCell axis="L" value={values.l} onChange={(v) => onChange('l', v)} />
        </div>
      ) : null}
    </div>
  );
}

function QuadCell({ axis, value, onChange }: { axis: string; value: string; onChange: (v: string) => void }) {
  return (
    <span className="cc-quad-cell">
      <em className="cc-quad-axis">{axis}</em>
      <input value={value} placeholder="0"
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v && /^-?\d+(\.\d+)?$/.test(v)) onChange(`${v}px`);
        }} />
      <em className="cc-quad-unit">px</em>
    </span>
  );
}

function sideToProp(base: 'padding' | 'margin', side: 't' | 'r' | 'b' | 'l'): keyof ManualEditStyles {
  return `${base}${sideUpper(side)}` as keyof ManualEditStyles;
}
function sideUpper(side: 't' | 'r' | 'b' | 'l'): 'Top' | 'Right' | 'Bottom' | 'Left' {
  return side === 't' ? 'Top' : side === 'r' ? 'Right' : side === 'b' ? 'Bottom' : 'Left';
}

function normalizeColorForPicker(value: string): string {
  const trimmed = value.trim();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) {
    if (trimmed.length === 4) {
      const r = trimmed[1]!, g = trimmed[2]!, b = trimmed[3]!;
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return trimmed.toLowerCase();
  }
  const match = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (match) {
    const toHex = (n: string) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    return `#${toHex(match[1]!)}${toHex(match[2]!)}${toHex(match[3]!)}`;
  }
  return '#000000';
}

export function manualEditPatchSummary(patch: ManualEditPatch): string {
  if (patch.kind === 'set-full-source') return JSON.stringify({ kind: patch.kind, bytes: patch.source.length });
  if (patch.kind === 'set-outer-html') return JSON.stringify({ id: patch.id, kind: patch.kind, bytes: patch.html.length });
  return JSON.stringify(patch);
}
