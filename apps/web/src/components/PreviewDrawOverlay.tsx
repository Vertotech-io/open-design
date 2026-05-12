import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

type Mode = 'click' | 'draw';

interface Point { x: number; y: number }
interface Stroke { points: Point[] }

export const ANNOTATION_EVENT = 'opendesign:annotation';

export interface AnnotationEventDetail {
  file: File | null;
  note: string;
}

interface Props {
  children: ReactNode;
}

const STROKE_COLOR = '#ff3b30';
const STROKE_WIDTH = 4;

export function PreviewDrawOverlay({ children }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<Mode>('click');
  const [note, setNote] = useState('');
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const [hasInk, setHasInk] = useState(false);

  const redraw = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = STROKE_WIDTH;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const dpr = window.devicePixelRatio || 1;
    const all = drawingRef.current ? [...strokesRef.current, drawingRef.current] : strokesRef.current;
    for (const s of all) {
      const first = s.points[0];
      if (!first) continue;
      ctx.beginPath();
      ctx.moveTo(first.x * dpr, first.y * dpr);
      for (let i = 1; i < s.points.length; i++) {
        const p = s.points[i]!;
        ctx.lineTo(p.x * dpr, p.y * dpr);
      }
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    const cvs = canvasRef.current;
    if (!wrap || !cvs) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cvs.width = Math.max(1, Math.floor(rect.width * dpr));
      cvs.height = Math.max(1, Math.floor(rect.height * dpr));
      cvs.style.width = `${rect.width}px`;
      cvs.style.height = `${rect.height}px`;
      redraw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw, mode, hasInk]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMode('click');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function pointFromEvent(e: React.PointerEvent): Point {
    const cvs = canvasRef.current!;
    const rect = cvs.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (mode !== 'draw') return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drawingRef.current = { points: [pointFromEvent(e)] };
    redraw();
  }
  function onPointerMove(e: React.PointerEvent) {
    if (mode !== 'draw' || !drawingRef.current) return;
    drawingRef.current.points.push(pointFromEvent(e));
    redraw();
  }
  function onPointerUp() {
    if (mode !== 'draw' || !drawingRef.current) return;
    if (drawingRef.current.points.length > 1) {
      strokesRef.current.push(drawingRef.current);
      setHasInk(true);
    }
    drawingRef.current = null;
    redraw();
  }

  function clearInk() {
    strokesRef.current = [];
    drawingRef.current = null;
    setHasInk(false);
    redraw();
  }

  async function requestSnapshot(): Promise<{ dataUrl: string; w: number; h: number } | null> {
    const iframe = wrapRef.current?.querySelector('iframe');
    const win = iframe?.contentWindow;
    if (!iframe || !win) return null;
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      let done = false;
      function onMsg(ev: MessageEvent) {
        const d = ev.data as { type?: string; id?: string; dataUrl?: string; w?: number; h?: number; error?: string } | null;
        if (!d || d.type !== 'od:snapshot:result' || d.id !== id) return;
        if (done) return;
        done = true;
        window.removeEventListener('message', onMsg);
        if (d.dataUrl && d.w && d.h) resolve({ dataUrl: d.dataUrl, w: d.w, h: d.h });
        else resolve(null);
      }
      window.addEventListener('message', onMsg);
      try { win.postMessage({ type: 'od:snapshot', id }, '*'); } catch { /* sandboxed */ }
      setTimeout(() => { if (!done) { done = true; window.removeEventListener('message', onMsg); resolve(null); } }, 2500);
    });
  }

  async function compositeWithBackground(snap: { dataUrl: string; w: number; h: number }): Promise<Blob | null> {
    const iframe = wrapRef.current?.querySelector('iframe');
    if (!iframe) return null;
    const rect = iframe.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = snap.w;
    out.height = snap.h;
    const ctx = out.getContext('2d');
    if (!ctx) return null;
    const bg = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = snap.dataUrl;
    });
    if (!bg) return null;
    ctx.drawImage(bg, 0, 0, snap.w, snap.h);
    const sx = snap.w / Math.max(1, rect.width);
    const sy = snap.h / Math.max(1, rect.height);
    ctx.strokeStyle = STROKE_COLOR;
    ctx.lineWidth = STROKE_WIDTH * Math.max(sx, sy);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokesRef.current) {
      const first = s.points[0];
      if (!first) continue;
      ctx.beginPath();
      ctx.moveTo(first.x * sx, first.y * sy);
      for (let i = 1; i < s.points.length; i++) {
        const p = s.points[i]!;
        ctx.lineTo(p.x * sx, p.y * sy);
      }
      ctx.stroke();
    }
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/png'));
  }

  async function send() {
    if (!hasInk && !note.trim()) return;
    let file: File | null = null;
    if (hasInk) {
      let blob: Blob | null = null;
      const snap = await requestSnapshot();
      if (snap) blob = await compositeWithBackground(snap);
      if (!blob) {
        const cvs = canvasRef.current;
        if (cvs) blob = await new Promise<Blob | null>((resolve) => cvs.toBlob((b) => resolve(b), 'image/png'));
      }
      if (blob) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        file = new File([blob], `drawing-${ts}.png`, { type: 'image/png' });
      }
    }
    const detail: AnnotationEventDetail = { file, note: note.trim() };
    window.dispatchEvent(new CustomEvent(ANNOTATION_EVENT, { detail }));
    clearInk();
    setNote('');
    setMode('click');
  }

  const overlayPointer = mode === 'draw' ? 'auto' : 'none';
  const showCanvas = mode === 'draw' || hasInk;

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
      }}
    >
      {children}
      {showCanvas ? (
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: overlayPointer,
            cursor: mode === 'draw' ? 'crosshair' : 'default',
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 16,
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          background: 'rgba(20,20,20,0.92)',
          color: '#fff',
          borderRadius: 999,
          boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
          backdropFilter: 'blur(8px)',
          zIndex: 10,
          pointerEvents: 'auto',
          fontSize: 13,
        }}
      >
        <button
          type="button"
          onClick={() => setMode((m) => (m === 'draw' ? 'click' : 'draw'))}
          style={pillStyle(mode === 'draw')}
          aria-pressed={mode === 'draw'}
        >
          Draw
        </button>
        <button
          type="button"
          onClick={() => setMode('click')}
          style={pillStyle(mode === 'click')}
          aria-pressed={mode === 'click'}
        >
          Click
        </button>
        {hasInk ? (
          <button type="button" onClick={clearInk} style={ghostStyle}>
            Clear
          </button>
        ) : null}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Type anywhere to add a note"
          style={{
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'inherit',
            width: 280,
            padding: '4px 8px',
            fontSize: 13,
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!hasInk && !note.trim()}
          style={{
            ...pillStyle(true),
            opacity: !hasInk && !note.trim() ? 0.4 : 1,
            cursor: !hasInk && !note.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    border: 'none',
    borderRadius: 999,
    padding: '4px 12px',
    fontSize: 13,
    cursor: 'pointer',
    background: active ? '#34c759' : 'transparent',
    color: active ? '#000' : 'inherit',
  };
}

const ghostStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: 999,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
  background: 'transparent',
  color: 'inherit',
};
