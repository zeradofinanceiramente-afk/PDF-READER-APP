import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import { Annotation, DriveFile } from '../types';
import { saveAnnotation, loadAnnotations } from '../services/storageService';
import { downloadDriveFile, uploadFileToDrive, deleteDriveFile } from '../services/driveService';
import { ArrowLeft, Highlighter, Loader2, X, Type, List, MousePointer2, Save, ScanLine, ZoomIn, ZoomOut, Menu, PaintBucket, Sliders, MoveHorizontal, Pen, Eraser, Copy, Download, FileText, Hash, Check, ChevronUp, ChevronDown } from 'lucide-react';

// Explicitly set worker to specific version to match package.json (5.4.449)
GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.449/build/pdf.worker.min.mjs`;

// --- Dynamic Font Loader ---
const attemptedFonts = new Set<string>();

/**
 * Tenta baixar automaticamente uma fonte do Google Fonts se ela não estiver no sistema.
 * Remove prefixos de subset (Ex: "ABCDE+Roboto-Bold" -> "Roboto")
 */
const tryAutoDownloadFont = (rawFontName: string) => {
  if (!navigator.onLine) return; // Não faz nada se offline
  
  // Limpeza do nome da fonte
  // 1. Remove aspas
  let cleanName = rawFontName.replace(/['"]/g, '').trim();
  
  // 2. Remove prefixo de subset do PDF (6 letras maiúsculas + '+')
  if (cleanName.includes('+')) {
    cleanName = cleanName.split('+')[1];
  }

  // 3. Extrai apenas o nome da família (remove -Bold, -Italic, etc para a busca na API)
  // Ex: "Roboto-Bold" -> "Roboto"
  const familyName = cleanName.split('-')[0];

  // Evita requisições duplicadas ou desnecessárias para fontes padrão
  const skipList = ['Arial', 'Helvetica', 'Times', 'Courier', 'Verdana', 'Georgia', 'sans-serif', 'serif', 'monospace'];
  if (attemptedFonts.has(familyName) || skipList.some(s => familyName.toLowerCase().includes(s.toLowerCase()))) {
    return;
  }

  attemptedFonts.add(familyName);
  console.log(`[Auto-Font] Tentando baixar fonte ausente: ${familyName}`);

  // Constrói URL do Google Fonts (solicitando pesos comuns para garantir compatibilidade)
  const googleFontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(familyName)}:wght@300;400;500;700&display=swap`;

  const link = document.createElement('link');
  link.href = googleFontUrl;
  link.rel = 'stylesheet';
  link.id = `dynamic-font-${familyName}`;

  link.onload = () => {
    console.log(`[Auto-Font] Fonte carregada com sucesso: ${familyName}`);
    // Força um reflow leve ou re-verificação se necessário, mas o browser costuma aplicar automaticamente
  };
  
  link.onerror = () => {
    console.warn(`[Auto-Font] Fonte não encontrada no Google Fonts: ${familyName}`);
    link.remove(); // Limpa se falhar
  };

  document.head.appendChild(link);
};

interface Props {
  accessToken?: string | null;
  fileId: string;
  fileName: string;
  fileParents?: string[];
  uid: string;
  onBack: () => void;
  fileBlob?: Blob;
  isPopup?: boolean;
  onToggleNavigation?: () => void;
  onAuthError?: () => void; // Prop para notificar erro de autenticação
}

interface SelectionState {
  page: number;
  text: string;
  // Position relative to the scrolling container
  popupX: number;
  popupY: number;
  // Rects normalized to PDF coordinates (scale=1)
  relativeRects: { x: number; y: number; width: number; height: number }[];
  position: 'top' | 'bottom'; // Control if popup is above or below selection
}

// --- Helper: Convert Points to SVG Path ---
const pointsToSvgPath = (points: number[][]) => {
  if (points.length === 0) return '';
  const d = points.map((p, i) => (i === 0 ? `M ${p[0]} ${p[1]}` : `L ${p[0]} ${p[1]}`)).join(' ');
  return d;
};

// --- Custom Text Renderer ---
const renderCustomTextLayer = (textContent: any, container: HTMLElement, viewport: any) => {
  container.innerHTML = '';
  
  // Track previous Y to detect line breaks
  let lastY = -1;

  textContent.items.forEach((item: any) => {
    // FIX: Do not trim whitespace. Rendering spaces is crucial for smooth text selection (prevents snapping).
    if (!item.str || item.str.length === 0) return;

    const tx = item.transform;
    const fontHeight = Math.sqrt(tx[3] * tx[3] + tx[2] * tx[2]);
    const fontWidth = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
    
    // Calculate precise position using viewport conversion
    const [x, y] = viewport.convertToViewportPoint(tx[4], tx[5]);

    // Calculate horizontal scale correction (stretch/squash factor)
    // tx[0] is roughly width scaling, tx[3] is height scaling (font size).
    // If they differ, the font is stretched in PDF. We must replicate this in CSS.
    // We use a safe default of 1 if calculation is weird (e.g. 0 height).
    const scaleX = fontHeight > 0 ? (fontWidth / fontHeight) : 1;

    const fontSize = fontHeight * viewport.scale;

    // --- FIX FOR SELECTION JUMPING ---
    // If the vertical position changes significantly (indicating a new line), insert a <br>.
    // This creates a DOM boundary preventing selection from merging adjacent lines/paragraphs.
    if (lastY !== -1 && Math.abs(y - lastY) > fontSize * 0.5) {
      container.appendChild(document.createElement('br'));
    }
    lastY = y;

    const span = document.createElement('span');
    span.textContent = item.str;
    
    // Position text at top-left. 
    // Note: y from convertToViewportPoint is the baseline. 
    // We adjust top by fontSize to position the span roughly correctly, 
    // but the most important part for alignment is 'left' and 'width' (via scaleX).
    span.style.left = `${x}px`;
    span.style.top = `${y - fontSize}px`; 
    span.style.fontSize = `${fontSize}px`;
    
    // Apply horizontal scaling to match PDF font width exactly
    if (Math.abs(scaleX - 1) > 0.01) {
      span.style.transform = `scaleX(${scaleX})`;
      span.style.transformOrigin = '0% 0%';
    }

    // Check for explicit font in PDF styles to respect TimesNewRoman or other specific fonts
    if (textContent.styles && item.fontName && textContent.styles[item.fontName]) {
      const fontData = textContent.styles[item.fontName];
      const fontFamily = fontData.fontFamily;
      
      span.style.fontFamily = fontFamily;

      // --- AUTO DOWNLOAD FONT LOGIC ---
      // Check if the font is available in the document.
      // We check for "12px FontName". If check returns false, the font is likely missing.
      if (fontFamily && !document.fonts.check(`12px "${fontFamily}"`)) {
         tryAutoDownloadFont(fontFamily);
      }
    } else {
      // Fallback
      span.style.fontFamily = "'Google Sans', 'Inter', sans-serif";
    }

    span.style.position = 'absolute';
    span.style.color = 'transparent';
    span.style.whiteSpace = 'pre';
    span.style.cursor = 'text';
    span.style.lineHeight = '1';
    span.style.pointerEvents = 'all';

    // Handle rotation if present in the matrix
    const angle = Math.atan2(tx[1], tx[0]);
    if (angle !== 0) {
      span.style.transform = `rotate(${angle}rad) scaleX(${scaleX})`;
    }

    container.appendChild(span);
  });
};

// --- Sub-Component: Individual Page Renderer ---
interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  currentScale: number; // The user's zoom level
  renderScale: number;  // The fixed quality level (e.g. 2.0)
  filterValues: string;
  annotations: Annotation[];
  activeTool: 'cursor' | 'text' | 'ink' | 'eraser';
  inkColor: string;
  inkStrokeWidth: number;
  inkOpacity: number;
  onPageClick: (page: number, x: number, y: number) => void;
  onDeleteAnnotation: (annotation: Annotation) => void;
  onAddInk: (ann: Annotation) => void;
  onAddNote: (ann: Annotation) => void;
}

const PdfPage: React.FC<PdfPageProps> = ({ 
  pdfDoc, 
  pageNumber, 
  currentScale,
  renderScale,
  filterValues, 
  annotations,
  activeTool,
  inkColor,
  inkStrokeWidth,
  inkOpacity,
  onPageClick,
  onDeleteAnnotation,
  onAddInk,
  onAddNote
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null); // Ref to track current render task
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  
  // States
  const [rendered, setRendered] = useState(false);
  const [hasText, setHasText] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  
  // Optimization: Cache page proxy to avoid async getPage calls on zoom
  const [pageProxy, setPageProxy] = useState<any>(null);

  // Ink State
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<number[][]>([]);

  // Draft Note State (for inline editor)
  const [draftNote, setDraftNote] = useState<{x: number, y: number, text: string} | null>(null);

  // Clear draft note if tool changes
  useEffect(() => {
    if (activeTool !== 'text') {
      setDraftNote(null);
    }
  }, [activeTool]);

  // Focus textarea when draft note opens
  useEffect(() => {
    if (draftNote && noteInputRef.current) {
      noteInputRef.current.focus();
    }
  }, [draftNote]);

  // 1. Setup Intersection Observer
  useEffect(() => {
    const element = pageContainerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      {
        root: null, // viewport
        rootMargin: '100% 0px', // Renderiza 1 tela inteira antes e depois (pre-load suave)
        threshold: 0
      }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 2. Fetch Page Proxy (Once per page mount)
  useEffect(() => {
    let active = true;
    const fetchPage = async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (active) {
          setPageProxy(page);
        }
      } catch (e) {
        console.error(`Error loading page ${pageNumber}`, e);
      }
    };
    fetchPage();
    return () => { active = false; };
  }, [pdfDoc, pageNumber]);

  // 3. Calculate Dimensions synchronously (depends on renderScale)
  const pageDimensions = useMemo(() => {
    if (!pageProxy) return null;
    const viewport = pageProxy.getViewport({ scale: renderScale });
    return { width: viewport.width, height: viewport.height };
  }, [pageProxy, renderScale]);

  // 4. Render Content (Only when Visible AND Dimensions set)
  // Crucial: We depend on renderScale, NOT currentScale. This prevents re-render on zoom.
  useEffect(() => {
    if (!isVisible || !pageDimensions || !pageProxy || !canvasRef.current || !textLayerRef.current) return;
    
    let active = true;

    const render = async () => {
      try {
        const viewport = pageProxy.getViewport({ scale: renderScale });
        
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Cancel previous render task if it exists to avoid "Same canvas" error
        if (renderTaskRef.current) {
          try {
            await renderTaskRef.current.cancel();
          } catch (e) {
            // Ignore cancellation errors
          }
        }

        canvas.width = viewport.width;
        canvas.height = viewport.height;
          
        const renderContext = {
            canvasContext: ctx,
            viewport: viewport,
        };

        // Render Canvas
        const task = pageProxy.render(renderContext);
        renderTaskRef.current = task;
        
        await task.promise;
        
        // If this task finished successfully and wasn't cancelled/replaced, clear ref
        if (renderTaskRef.current === task) {
             renderTaskRef.current = null;
        }
          
        if (!active) return;
          
        // Render Text
        const textContent = await pageProxy.getTextContent();
        if (!active) return;
          
        setHasText(textContent.items.length > 0);

        const textLayerDiv = textLayerRef.current;
        if (textLayerDiv) {
            textLayerDiv.style.width = `${viewport.width}px`;
            textLayerDiv.style.height = `${viewport.height}px`;
            renderCustomTextLayer(textContent, textLayerDiv, viewport);
        }
          
        setRendered(true);
      } catch (err: any) {
        // Ignore rendering cancelled errors as they are expected when scrolling fast
        if (err?.name === 'RenderingCancelledException') {
            return;
        }
        if (active) console.error(`Error rendering page ${pageNumber}`, err);
      }
    };

    render();
    
    // Cleanup: cancel any pending render
    return () => { 
      active = false; 
      if (renderTaskRef.current) {
          renderTaskRef.current.cancel().catch(() => {});
          renderTaskRef.current = null;
      }
    };
  }, [pageProxy, renderScale, isVisible, pageDimensions]);

  const handleContainerClick = (e: React.MouseEvent) => {
    if (activeTool !== 'text' || !pageContainerRef.current) return;
    if ((e.target as HTMLElement).closest('.annotation-item')) return;
    if ((e.target as HTMLElement).closest('.note-editor')) return;

    const rect = pageContainerRef.current.getBoundingClientRect();
    // Normalize coordinates to PDF scale=1 using currentScale (since rect includes the CSS transform)
    const x = (e.clientX - rect.left) / currentScale;
    const y = (e.clientY - rect.top) / currentScale;
    
    // If Text tool is active, start a Draft Note instead of generic click
    setDraftNote({ x, y, text: '' });
  };

  const handleSaveDraftNote = () => {
    if (draftNote && draftNote.text.trim()) {
      onAddNote({
        id: `temp-note-${Date.now()}-${Math.random()}`,
        page: pageNumber,
        bbox: [draftNote.x, draftNote.y, 0, 0],
        type: 'note',
        text: draftNote.text,
        color: '#fef9c3',
        opacity: 1
      });
    }
    setDraftNote(null);
  };

  // --- Ink Handling ---
  const handlePointerDown = (e: React.PointerEvent) => {
    if (activeTool !== 'ink' || !pageContainerRef.current) return;
    e.preventDefault(); 
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const rect = pageContainerRef.current.getBoundingClientRect();
    // Normalize coordinates to PDF scale=1
    const x = (e.clientX - rect.left) / currentScale;
    const y = (e.clientY - rect.top) / currentScale;

    setIsDrawing(true);
    setCurrentPoints([[x, y]]);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing || activeTool !== 'ink' || !pageContainerRef.current) return;
    e.preventDefault();

    const rect = pageContainerRef.current.getBoundingClientRect();
    // Normalize coordinates to PDF scale=1
    const x = (e.clientX - rect.left) / currentScale;
    const y = (e.clientY - rect.top) / currentScale;

    setCurrentPoints(prev => [...prev, [x, y]]);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!isDrawing || activeTool !== 'ink') return;
    e.preventDefault();
    setIsDrawing(false);

    if (currentPoints.length > 1) {
      onAddInk({
        id: `temp-${Date.now()}-${Math.random()}`, 
        page: pageNumber,
        bbox: [0, 0, 0, 0], 
        type: 'ink',
        points: currentPoints, // Already normalized
        color: inkColor,
        strokeWidth: inkStrokeWidth,
        opacity: inkOpacity
      });
    }
    setCurrentPoints([]);
  };

  // Layout Dimensions (The spacer container)
  const layoutWidth = pageDimensions ? pageDimensions.width * (currentScale / renderScale) : '100%';
  const layoutHeight = pageDimensions ? pageDimensions.height * (currentScale / renderScale) : `${800 * currentScale}px`;

  // Internal Rendering Dimensions
  const internalWidth = pageDimensions ? pageDimensions.width : '100%';
  const internalHeight = pageDimensions ? pageDimensions.height : '800px';

  // CSS Transform to scale the rendered content to the visual size
  const transformScale = currentScale / renderScale;

  return (
    <div 
      ref={pageContainerRef}
      className={`pdf-page relative bg-white mb-4 md:mb-8 mx-auto transition-cursor select-none ${activeTool === 'text' ? 'cursor-text' : activeTool === 'ink' ? 'cursor-crosshair touch-none' : activeTool === 'eraser' ? 'cursor-[url(https://cdn-icons-png.flaticon.com/32/2661/2661282.png),_pointer]' : ''}`}
      data-page-number={pageNumber}
      style={{ 
        width: layoutWidth, 
        height: layoutHeight,
        boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)'
      }}
      onClick={handleContainerClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {/* Transformed Content Container */}
      <div 
        style={{
          width: internalWidth,
          height: internalHeight,
          transform: `scale(${transformScale})`,
          transformOrigin: '0 0',
          position: 'relative'
        }}
      >
        {!hasText && rendered && isVisible && (
           <div className="absolute -top-6 left-0 flex items-center gap-1 text-xs text-text-sec opacity-70" style={{ transform: `scale(${1/transformScale})`, transformOrigin: '0 0' }}>
              <ScanLine size={12} />
              <span>Imagem (sem texto selecionável)</span>
           </div>
        )}

        {/* Placeholder Loading State */}
        {!rendered && isVisible && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 text-gray-300">
             <Loader2 className="animate-spin w-8 h-8" />
          </div>
        )}

        <canvas 
          ref={canvasRef}
          style={{ 
            filter: 'url(#pdf-recolor)',
            display: 'block',
            visibility: isVisible ? 'visible' : 'hidden'
          }}
        />

        {/* Draft Note Editor (Visual Input) */}
        {draftNote && (
          <div 
            className="note-editor absolute z-50 animate-in zoom-in duration-200"
            style={{
              left: draftNote.x * renderScale,
              top: draftNote.y * renderScale,
              maxWidth: '250px',
              transform: `scale(${1/transformScale})`, // Counter-scale to keep UI constant size
              transformOrigin: 'top left'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-yellow-100 text-gray-900 rounded-lg shadow-xl border border-yellow-300 p-2 flex flex-col gap-2 w-64">
               <div className="flex items-center justify-between border-b border-yellow-200/50 pb-1 mb-1">
                 <span className="text-[10px] uppercase font-bold text-yellow-800 tracking-wider">Nova Nota</span>
               </div>
               <textarea 
                 ref={noteInputRef}
                 value={draftNote.text}
                 onChange={(e) => setDraftNote({ ...draftNote, text: e.target.value })}
                 placeholder="Digite sua anotação..."
                 className="bg-transparent w-full text-sm resize-none outline-none min-h-[80px] leading-relaxed placeholder:text-yellow-700/50"
               />
               <div className="flex items-center gap-2 justify-end pt-1">
                 <button 
                    onClick={() => setDraftNote(null)}
                    className="p-1.5 rounded-md hover:bg-yellow-200 text-yellow-800 transition-colors"
                    title="Cancelar"
                 >
                    <X size={16} />
                 </button>
                 <button 
                    onClick={handleSaveDraftNote}
                    className="flex items-center gap-1 px-3 py-1.5 bg-yellow-400 hover:bg-yellow-500 text-yellow-950 rounded-md text-xs font-bold transition-colors shadow-sm"
                 >
                    <Check size={14} />
                    Salvar
                 </button>
               </div>
            </div>
          </div>
        )}

        {/* Annotations Layer */}
        {isVisible && (
          <div className="absolute inset-0 pointer-events-none">
            {/* SVG Layer for Ink - Scaled via Group transform to match current zoom */}
            <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 15 }}>
              <g transform={`scale(${renderScale})`}>
                {annotations.filter(a => a.type === 'ink').map((ann, i) => (
                  <path
                    key={ann.id || `ink-${i}`}
                    d={pointsToSvgPath(ann.points || [])}
                    stroke={ann.color || 'red'}
                    strokeWidth={ann.strokeWidth || 3}
                    strokeOpacity={ann.opacity ?? 1}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={activeTool === 'eraser' ? 'hover:opacity-50 cursor-pointer' : ''}
                    style={{ 
                      pointerEvents: activeTool === 'eraser' ? 'visibleStroke' : 'none',
                      cursor: activeTool === 'eraser' ? 'url(https://cdn-icons-png.flaticon.com/32/2661/2661282.png), pointer' : 'none'
                    }}
                    onClick={(e) => {
                      if (activeTool === 'eraser' && ann.id) {
                        e.stopPropagation();
                        onDeleteAnnotation(ann); 
                      }
                    }}
                  />
                ))}
                {/* Current Drawing Stroke */}
                {isDrawing && (
                  <path 
                    d={pointsToSvgPath(currentPoints)}
                    stroke={inkColor}
                    strokeWidth={inkStrokeWidth}
                    strokeOpacity={inkOpacity}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </g>
            </svg>

            {annotations.map((ann, i) => {
              const isHighlight = ann.type === 'highlight';
              
              // We use renderScale here because we are inside the transformed container
              const x = ann.bbox[0] * renderScale;
              const y = ann.bbox[1] * renderScale;
              const w = ann.bbox[2] * renderScale;
              const h = ann.bbox[3] * renderScale;

              if (isHighlight) {
                return (
                  <div 
                    key={ann.id || i}
                    id={`ann-${ann.id}`}
                    className="annotation-item absolute mix-blend-multiply group pointer-events-auto"
                    style={{
                      left: x,
                      top: y,
                      width: w,
                      height: h,
                      backgroundColor: ann.color || '#facc15',
                      opacity: ann.opacity ?? 0.4,
                      pointerEvents: activeTool === 'cursor' ? 'none' : 'auto',
                      cursor: activeTool === 'eraser' ? 'url(https://cdn-icons-png.flaticon.com/32/2661/2661282.png), pointer' : 'default'
                    }}
                    onClick={(e) => {
                      if (activeTool === 'eraser' && ann.id) {
                        e.stopPropagation();
                        onDeleteAnnotation(ann);
                      }
                    }}
                  />
                );
              } else if (ann.type === 'note') {
                return (
                  <div
                    key={ann.id || i}
                    id={`ann-${ann.id}`}
                    className="annotation-item absolute z-20 group pointer-events-auto animate-in zoom-in duration-200"
                    style={{
                      left: x,
                      top: y,
                      maxWidth: '200px',
                      cursor: activeTool === 'eraser' ? 'url(https://cdn-icons-png.flaticon.com/32/2661/2661282.png), pointer' : 'auto',
                      // Counter-scale notes so they don't get huge when zoomed
                      transform: `scale(${1/transformScale})`,
                      transformOrigin: 'top left' 
                    }}
                    onClick={(e) => {
                      if (activeTool === 'eraser' && ann.id) {
                        e.stopPropagation();
                        onDeleteAnnotation(ann);
                      }
                    }}
                  >
                    <div 
                      className={`bg-yellow-100 text-gray-900 text-sm p-3 rounded-br-xl rounded-bl-sm rounded-tr-sm rounded-tl-sm shadow-md border border-yellow-300 relative hover:scale-105 transition-transform ${activeTool === 'eraser' ? 'hover:opacity-50' : ''}`}
                      style={{ backgroundColor: ann.color || '#fef9c3' }}
                    >
                      <p className="whitespace-pre-wrap break-words font-medium leading-relaxed">{ann.text}</p>
                      
                      {ann.id && !ann.id.startsWith('temp') && activeTool !== 'eraser' && (
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteAnnotation(ann);
                          }}
                          className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-sm pointer-events-auto cursor-pointer"
                          title="Excluir Nota"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}

        <div 
          ref={textLayerRef} 
          className={`textLayer ${activeTool === 'text' ? 'pointer-events-none' : ''}`}
          style={{ 
            zIndex: 10, 
            pointerEvents: activeTool === 'ink' || activeTool === 'eraser' ? 'none' : 'auto',
            visibility: isVisible ? 'visible' : 'hidden'
          }}
        />
      </div>
    </div>
  );
};

// --- Main Component ---

export const PdfViewer: React.FC<Props> = ({ accessToken, fileId, fileName, fileParents, uid, onBack, fileBlob, isPopup, onToggleNavigation, onAuthError }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  
  // Page Navigation State
  const [currentPageNumber, setCurrentPageNumber] = useState(1);
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [tempPageInput, setTempPageInput] = useState("1");
  
  // Fixed Render Scale: 2.0 provides good quality up to 200% zoom.
  // We use CSS transforms to scale visually, keeping DOM intact.
  const RENDER_SCALE = 2.0;
  
  const [scale, setScale] = useState(1.0); // Visual scale
  
  // Selection & Tools State
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [activeTool, setActiveTool] = useState<'cursor' | 'text' | 'ink' | 'eraser'>('cursor');
  const [showSidebar, setShowSidebar] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'annotations' | 'settings' | 'fichamento'>('annotations');

  // Settings State
  const [pageColor, setPageColor] = useState("#ffffff");
  const [textColor, setTextColor] = useState("#000000");
  const [highlightColor, setHighlightColor] = useState("#facc15"); 
  const [highlightOpacity, setHighlightOpacity] = useState(0.4);
  const [pageOffset, setPageOffset] = useState(1);
  
  // Ink Settings
  const [inkColor, setInkColor] = useState("#22c55e"); // Green by default
  const [inkStrokeWidth, setInkStrokeWidth] = useState(20); // 20px by default
  const [inkOpacity, setInkOpacity] = useState(0.5); // 50% opacity by default

  // Update Page Title (Native Multi-Window Task Label)
  useEffect(() => {
    document.title = fileName;
    return () => {
      document.title = "Anotador de PDF Drive";
    };
  }, [fileName]);

  // Fichamento Text Generation
  const fichamentoText = useMemo(() => {
    // Filter annotations that have text
    const textAnnotations = annotations
      .filter(a => (a.type === 'highlight' || a.type === 'note') && a.text && a.text.trim().length > 0)
      .sort((a, b) => {
        // Sort by page first
        if (a.page !== b.page) return a.page - b.page;
        // Then by vertical position (top to bottom)
        return a.bbox[1] - b.bbox[1];
      });

    if (textAnnotations.length === 0) return "";

    // DEDUPLICATION:
    const seenTexts = new Set<string>();
    const uniqueAnnotations: Annotation[] = [];

    textAnnotations.forEach(ann => {
      // Create a unique key for the content on this page
      const key = `${ann.page}|${ann.text}`;
      
      if (!seenTexts.has(key)) {
        seenTexts.add(key);
        uniqueAnnotations.push(ann);
      }
    });

    return uniqueAnnotations
      .map(a => `Página ${a.page + pageOffset - 1}\n${a.text}`)
      .join('\n\n');
  }, [annotations, pageOffset]);

  // Sidebar List Generation (Annotations Tab)
  const sidebarAnnotations = useMemo(() => {
    const sorted = [...annotations].sort((a, b) => {
        if (a.page !== b.page) return a.page - b.page;
        return a.bbox[1] - b.bbox[1];
    });

    const uniqueList: Annotation[] = [];
    const seenTextOnPage = new Set<string>();

    sorted.forEach(ann => {
        // Always include Ink or items without text (though highlights usually have text)
        if (ann.type === 'ink' || !ann.text) {
          uniqueList.push(ann);
          return;
        }

        // For text-based annotations (Highlight/Note), check duplicates based on page + text content
        const key = `${ann.page}|${ann.text}`;
        if (!seenTextOnPage.has(key)) {
            seenTextOnPage.add(key);
            uniqueList.push(ann);
        }
    });

    return uniqueList;
  }, [annotations]);

  const handleCopyFichamento = () => {
    navigator.clipboard.writeText(fichamentoText);
    alert("Fichamento copiado para a área de transferência!");
  };

  const handleDownloadFichamento = () => {
    const blob = new Blob([fichamentoText], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Fichamento - ${fileName}.txt`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleDeleteAnnotation = useCallback((target: Annotation) => {
    // If it's a Note or Ink or doesn't have text, try deleting by ID first
    if (target.type === 'ink' || target.type === 'note' || !target.text) {
         // Delete specific item (Ink or valid ID)
         if (target.id) {
            setAnnotations(prev => prev.filter(a => a.id !== target.id));
         }
    } else {
         // Delete all highlights with same text on this page (removes the "ghost" fragments of a multi-line highlight)
         setAnnotations(prev => prev.filter(a => 
             !(a.page === target.page && a.text === target.text && a.type === target.type)
         ));
    }
  }, []);

  // Load PDF
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        let blob: Blob;

        // Use existing blob if available (prevents error on auth refresh/logout if file is already loaded)
        if (fileBlob) {
          blob = fileBlob;
        } else if (originalBlob) {
          blob = originalBlob;
        } else if (accessToken) {
          blob = await downloadDriveFile(accessToken, fileId);
        } else {
          // If we have no source at all (and no cached blob), we can't load.
          throw new Error("No file source provided");
        }
        
        // If reusing existing blob and doc is ready, skip
        if (originalBlob && pdfDoc) {
             return;
        }

        setLoading(true);

        if (mounted && !originalBlob) setOriginalBlob(blob);

        const arrayBuffer = await blob.arrayBuffer();
        const pdf = await getDocument({ data: arrayBuffer }).promise;
        
        if (mounted) {
          setPdfDoc(pdf);
          setNumPages(pdf.numPages);
          const existingAnns = await loadAnnotations(uid, fileId);
          setAnnotations(existingAnns);

          // Calculate Auto-Fit Width
          try {
            const page = await pdf.getPage(1);
            // Get viewport at standard scale to calculate fit
            const viewport = page.getViewport({ scale: 1 });
            const containerWidth = window.innerWidth;
            const isMobile = containerWidth < 768;
            
            // On mobile, use minimal padding (10px). On desktop, larger padding (80px).
            const padding = isMobile ? 10 : 80; 
            const autoScale = (containerWidth - padding) / viewport.width;
            
            // Limit max auto-scale to avoid extreme zoom on very small docs
            setScale(Math.min(autoScale, 2.5)); 
          } catch (e) {
            console.error("Error calculating auto-width:", e);
            setScale(1.2); // Fallback
          }
        }
      } catch (err: any) {
        console.error("Error loading PDF:", err);
        // Intercept 401 Unauthorized
        if (err.message === "Unauthorized" || (err.message && err.message.includes("401"))) {
            if (onAuthError) {
                onAuthError();
                // We do NOT set loading to false here to avoid flashing empty state before renewal overlay appears
                return;
            }
        }
        
        if (mounted) {
            alert(`Falha ao carregar PDF. Verifique se o arquivo é válido. (Erro: ${err instanceof Error ? err.message : String(err)})`);
            setLoading(false);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };

    init();
    return () => { mounted = false; };
  }, [accessToken, fileId, uid, fileBlob]); // Dependencies dictate when to run. We use state refs inside to be smart.

  // Helper to manually trigger Fit Width
  const handleFitWidth = async () => {
    if (!pdfDoc) return;
    try {
      const page = await pdfDoc.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const containerWidth = containerRef.current?.clientWidth || window.innerWidth;
      const isMobile = window.innerWidth < 768;
      const padding = isMobile ? 10 : 80;
      const newScale = (containerWidth - padding) / viewport.width;
      setScale(newScale);
    } catch (e) {
      console.error(e);
    }
  };

  // --- Scroll Detection Logic ---
  const handleScroll = useCallback(() => {
    if (scrollTimeoutRef.current) return;
    
    // Throttle scroll events (100ms)
    scrollTimeoutRef.current = setTimeout(() => {
        if (!containerRef.current) {
            scrollTimeoutRef.current = null;
            return;
        }

        const container = containerRef.current;
        const containerRect = container.getBoundingClientRect();
        
        // Find which page is most visible (closest to vertical center of viewport)
        const centerY = containerRect.top + (containerRect.height / 2);
        
        const pages = container.querySelectorAll('.pdf-page');
        let closestPage = currentPageNumber;
        let minDistance = Infinity;

        pages.forEach((page) => {
            const rect = page.getBoundingClientRect();
            // Distance from page center to viewport center
            const pageCenterY = rect.top + (rect.height / 2);
            const distance = Math.abs(pageCenterY - centerY);

            if (distance < minDistance) {
                minDistance = distance;
                const pageNum = parseInt(page.getAttribute('data-page-number') || '1');
                if (!isNaN(pageNum)) {
                    closestPage = pageNum;
                }
            }
        });

        if (closestPage !== currentPageNumber && !isEditingPage) {
            setCurrentPageNumber(closestPage);
        }

        scrollTimeoutRef.current = null;
    }, 100);
  }, [currentPageNumber, isEditingPage]);

  // --- Jump to Page Logic ---
  const jumpToPage = useCallback((pageNumber: number) => {
     if (pageNumber < 1) pageNumber = 1;
     if (pageNumber > numPages) pageNumber = numPages;

     const pageEl = containerRef.current?.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
     if (pageEl) {
         pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
         setCurrentPageNumber(pageNumber); // Optimistic update
     }
  }, [numPages]);

  const handlePageSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const page = parseInt(tempPageInput);
    if (!isNaN(page)) {
        jumpToPage(page);
    }
    setIsEditingPage(false);
  };

  // Global Selection Handler (For Highlight)
  useEffect(() => {
    const handleSelectionEnd = (e: Event) => {
      if (activeTool === 'text' || activeTool === 'ink' || activeTool === 'eraser') return;
      if (e.target instanceof Element && e.target.closest('button, input, select, .ui-panel, textarea, .note-editor')) return;

      setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
          setSelection(null);
          return;
        }

        const text = sel.toString().trim();
        if (text.length === 0) {
          setSelection(null);
          return;
        }

        let node = sel.anchorNode;
        if (node && node.nodeType === 3) node = node.parentNode; 
        
        const pageElement = (node as Element)?.closest('.pdf-page');
        if (!pageElement || !containerRef.current) {
          setSelection(null);
          return;
        }

        const pageNumAttr = pageElement.getAttribute('data-page-number');
        if (!pageNumAttr) return;
        const pageNum = parseInt(pageNumAttr);

        const range = sel.getRangeAt(0);
        const rects = Array.from(range.getClientRects());
        if (rects.length === 0) return;

        const boundingRect = range.getBoundingClientRect();
        const container = containerRef.current;
        const containerRect = container.getBoundingClientRect();
        
        // Calculate coords relative to the container content area (for popup)
        // Default: Bottom of selection
        let popupY = boundingRect.bottom - containerRect.top + container.scrollTop + 10;
        let position: 'top' | 'bottom' = 'bottom';

        // Check if popup would go below the visible container area
        // boundingRect.bottom is relative to viewport. containerRect.bottom is relative to viewport.
        const gapBelow = containerRect.bottom - boundingRect.bottom;
        
        // If less than 60px space below, show ABOVE selection
        if (gapBelow < 60) {
           popupY = boundingRect.top - containerRect.top + container.scrollTop - 60; // 60px approx height + padding
           position = 'top';
        }

        const popupX = boundingRect.left - containerRect.left + container.scrollLeft + (boundingRect.width / 2);

        const pageRect = pageElement.getBoundingClientRect();
        // NORMALIZE RECTS: Convert screen pixels to PDF Points (scale = 1)
        // We divide by currentScale because the pageRect includes the CSS transform scale.
        const relativeRects = rects.map(r => ({
          x: (r.left - pageRect.left) / scale,
          y: (r.top - pageRect.top) / scale,
          width: r.width / scale,
          height: r.height / scale
        }));

        setSelection({
          page: pageNum,
          text: text,
          popupX,
          popupY,
          relativeRects,
          position
        });
      }, 50);
    };

    document.addEventListener('mouseup', handleSelectionEnd);
    document.addEventListener('touchend', handleSelectionEnd);
    document.addEventListener('keyup', handleSelectionEnd);
    
    return () => {
      document.removeEventListener('mouseup', handleSelectionEnd);
      document.removeEventListener('touchend', handleSelectionEnd);
      document.removeEventListener('keyup', handleSelectionEnd);
    };
  }, [activeTool, scale]); // Added scale as dependency to ensure normalization uses current value


  const createHighlight = async () => {
    if (!selection) return;

    const newAnns: Annotation[] = selection.relativeRects.map(rect => {
      return {
        id: `temp-hl-${Date.now()}-${Math.random()}`,
        page: selection.page,
        bbox: [
          rect.x, 
          rect.y, 
          rect.width, 
          rect.height
        ], // Already normalized
        type: 'highlight',
        text: selection.text,
        color: highlightColor,
        opacity: highlightOpacity
      };
    });

    setAnnotations(prev => [...prev, ...newAnns]);
    setSelection(null);
    window.getSelection()?.removeAllRanges();

    saveAnnotationsList(newAnns);
  };

  const handleAddNote = useCallback(async (ann: Annotation) => {
    setAnnotations(prev => [...prev, ann]);
    saveAnnotationsList([ann]);
    setActiveTool('cursor'); // Reset tool after adding
  }, []);

  const addInkAnnotation = useCallback(async (ann: Annotation) => {
    // ann already has temp id from PdfPage and normalized points
    setAnnotations(prev => [...prev, ann]);
    saveAnnotationsList([ann]);
  }, []);

  const saveAnnotationsList = async (anns: Annotation[]) => {
    setIsSaving(true);
    try {
      for (const ann of anns) {
         await saveAnnotation(uid, fileId, ann);
      }
    } catch (err) {
      console.error("Failed to save annotation", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveToDrive = async () => {
    if (!accessToken || !originalBlob) {
      alert("Erro: Arquivo ou sessão inválida.");
      return;
    }

    const confirmSave = window.confirm(
      "Isso criará uma versão anotada e SUBSTITUIRÁ o arquivo original. As anotações ficarão permanentes no PDF. Deseja continuar?"
    );

    if (!confirmSave) return;

    setIsExporting(true);

    try {
      const existingPdfBytes = await originalBlob.arrayBuffer();
      const pdfDoc = await PDFDocument.load(existingPdfBytes);
      const pages = pdfDoc.getPages();

      const hexToRgb = (hex: string) => {
        const bigint = parseInt(hex.replace('#', ''), 16);
        const r = (bigint >> 16) & 255;
        const g = (bigint >> 8) & 255;
        const b = bigint & 255;
        return rgb(r / 255, g / 255, b / 255);
      };

      for (const ann of annotations) {
        if (ann.page > pages.length) continue;
        const page = pages[ann.page - 1]; 
        const { height } = page.getSize();
        
        if (ann.type === 'highlight') {
          // BBox is normalized PDF units (scale=1). No need to divide by current view scale.
          const rectX = ann.bbox[0];
          const rectY = ann.bbox[1];
          const rectW = ann.bbox[2];
          const rectH = ann.bbox[3];
          
          // PDF coordinates are bottom-left origin. Flip Y.
          const pdfY = height - rectY - rectH;

          page.drawRectangle({
            x: rectX,
            y: pdfY,
            width: rectW,
            height: rectH,
            color: hexToRgb(ann.color || '#facc15'),
            opacity: ann.opacity ?? 0.4,
          });
        } else if (ann.type === 'note' && ann.text) {
          const rectX = ann.bbox[0];
          const rectY = ann.bbox[1];
          const noteColor = hexToRgb(ann.color || '#fef9c3');
          page.drawRectangle({
            x: rectX,
            y: height - rectY - 20,
            width: 150,
            height: 50,
            color: noteColor,
          });
        } else if (ann.type === 'ink' && ann.points && ann.points.length > 0) {
           const color = hexToRgb(ann.color || '#ff0000');
           const width = ann.strokeWidth || 3; 
           
           for (let i = 0; i < ann.points.length - 1; i++) {
             const p1 = ann.points[i];
             const p2 = ann.points[i+1];
             // Points are normalized. No scale division needed.
             page.drawLine({
               start: { x: p1[0], y: height - p1[1] },
               end: { x: p2[0], y: height - p2[1] },
               thickness: width, // Thickness might need tuning as it's in PDF units now
               color: color,
               opacity: ann.opacity ?? 0.5
             });
           }
        }
      }

      const pdfBytes = await pdfDoc.save();
      const newPdfBlob = new Blob([pdfBytes as any], { type: 'application/pdf' });
      const newFileName = fileName; 
      await uploadFileToDrive(accessToken, newPdfBlob, newFileName, fileParents);
      await deleteDriveFile(accessToken, fileId);

      alert(`Sucesso! O arquivo original foi substituído pela versão anotada.`);
      onBack();

    } catch (err: any) {
      console.error("Export error:", err);
      // Intercept 401
      if (err.message === "Unauthorized" || (err.message && err.message.includes("401"))) {
         if (onAuthError) {
             onAuthError();
             return;
         }
      }
      alert("Falha ao salvar no Drive: " + err.message);
    } finally {
      setIsExporting(false);
    }
  };


  const scrollToAnnotation = (ann: Annotation) => {
    const pageEl = document.querySelector(`.pdf-page[data-page-number="${ann.page}"]`);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (ann.id) {
        setTimeout(() => {
          const el = document.getElementById(`ann-${ann.id}`);
          if (el) {
            el.style.outline = '2px solid red';
            setTimeout(() => el.style.outline = 'none', 1000);
          }
        }, 500);
      }
    }
    // Close sidebar on mobile after clicking
    if (window.innerWidth < 768) setShowSidebar(false);
  };

  const filterValues = useMemo(() => {
    const hexToRgb = (hex: string) => {
      const bigint = parseInt(hex.slice(1), 16);
      return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
    };

    const [tr, tg, tb] = hexToRgb(textColor);
    const [br, bg, bb] = hexToRgb(pageColor);

    const rScale = (br - tr) / 255;
    const gScale = (bg - tg) / 255;
    const bScale = (bb - tb) / 255;

    const rOffset = tr / 255;
    const gOffset = tg / 255;
    const bOffset = tb / 255;

    return `
      ${rScale} 0 0 0 ${rOffset}
      0 ${gScale} 0 0 ${gOffset}
      0 0 ${bScale} 0 ${bOffset}
      0 0 0 1 0
    `;
  }, [textColor, pageColor]);


  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-bg text-text">
        <Loader2 className="animate-spin h-10 w-10 text-brand mx-auto mb-4" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-text relative transition-colors duration-300">
      <svg className="hidden">
        <filter id="pdf-recolor">
          <feColorMatrix type="matrix" values={filterValues} />
        </filter>
      </svg>

      {/* Minimal Header */}
      <div className="h-14 bg-surface/80 backdrop-blur border-b border-border flex items-center justify-between px-4 sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          {!isPopup && onToggleNavigation && (
            <button 
                onClick={onToggleNavigation}
                className="p-2 -ml-2 hover:bg-white/10 rounded-full transition text-text mr-1"
                title="Menu"
            >
                <Menu size={20} />
            </button>
          )}
          <button 
            onClick={onBack} 
            className={`p-2 hover:bg-white/10 rounded-full transition text-text ${!onToggleNavigation ? '-ml-2' : ''}`}
            title={isPopup ? "Fechar Janela" : "Voltar e Fechar"}
          >
            {isPopup ? <X size={20} /> : <ArrowLeft size={20} />}
          </button>
          <div className="flex flex-col min-w-0">
             <h1 className="text-text font-medium truncate text-sm md:text-base">{fileName}</h1>
             <span className="text-xs text-text-sec">{numPages} páginas</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
            {isSaving && <Loader2 size={16} className="animate-spin text-brand" />}
            
            {/* Save Button Moved to Header */}
            <button 
                onClick={handleSaveToDrive}
                className="flex items-center gap-2 px-3 py-1.5 bg-brand text-bg rounded-full text-sm font-medium hover:brightness-110 transition-all shadow-lg shadow-brand/20"
                title="Salvar alterações no Drive"
            >
                <Save size={16} />
                <span className="hidden sm:inline">Salvar</span>
            </button>

            <button 
                onClick={() => setShowSidebar(true)} 
                className="p-2 hover:bg-white/10 rounded-full transition text-text"
            >
                <Menu size={20} />
            </button>
        </div>
      </div>

      {/* Main Content Area: Viewer + Sidebar */}
      <div className="flex-1 flex overflow-hidden relative">
        
        {/* Sidebar Overlay (Mobile & Desktop) */}
        {showSidebar && (
            <div className="absolute inset-0 z-40 flex justify-end">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setShowSidebar(false)} />
                <div className="relative w-80 bg-surface h-full shadow-2xl flex flex-col animate-in slide-in-from-right-10 duration-200">
                    
                    {/* Sidebar Header */}
                    <div className="flex items-center justify-between p-4 border-b border-border">
                        <span className="font-semibold text-text">Menu</span>
                        <button onClick={() => setShowSidebar(false)} className="text-text-sec hover:text-text">
                            <X size={20} />
                        </button>
                    </div>

                    {/* Sidebar Tabs */}
                    <div className="flex border-b border-border">
                        <button 
                            onClick={() => setSidebarTab('annotations')}
                            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${sidebarTab === 'annotations' ? 'border-brand text-brand' : 'border-transparent text-text-sec hover:text-text'}`}
                        >
                            Anotações
                        </button>
                        <button 
                            onClick={() => setSidebarTab('fichamento')}
                            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${sidebarTab === 'fichamento' ? 'border-brand text-brand' : 'border-transparent text-text-sec hover:text-text'}`}
                        >
                            Fichamento
                        </button>
                        <button 
                            onClick={() => setSidebarTab('settings')}
                            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${sidebarTab === 'settings' ? 'border-brand text-brand' : 'border-transparent text-text-sec hover:text-text'}`}
                        >
                            Ajustes
                        </button>
                    </div>

                    {/* Sidebar Content */}
                    <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                        {sidebarTab === 'annotations' ? (
                            <div className="space-y-3">
                                {sidebarAnnotations.length === 0 && (
                                    <div className="text-center text-text-sec py-10 text-sm">
                                        Nenhuma anotação. <br/> Selecione texto ou desenhe para começar.
                                    </div>
                                )}
                                {sidebarAnnotations.map((ann, idx) => (
                                    <div 
                                        key={ann.id || idx}
                                        onClick={() => scrollToAnnotation(ann)}
                                        className="bg-bg p-3 rounded-lg border border-border hover:border-brand cursor-pointer group transition-colors relative"
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className={`w-2 h-2 rounded-full`} style={{ backgroundColor: ann.color || (ann.type === 'highlight' ? highlightColor : '#fef9c3') }} />
                                            <span className="text-xs text-text-sec uppercase font-bold tracking-wider">Pág {ann.page + pageOffset - 1}</span>
                                            {ann.type === 'ink' && <span className="text-xs text-text-sec bg-surface px-1 rounded border border-border">Desenho</span>}
                                        </div>
                                        <p className="text-sm text-text line-clamp-2 leading-relaxed">
                                            {ann.text || (ann.type === 'ink' ? "Desenho manual" : "Sem conteúdo")}
                                        </p>
                                        <button 
                                          onClick={(e) => { 
                                              e.stopPropagation(); 
                                              handleDeleteAnnotation(ann);
                                          }}
                                          className="absolute top-2 right-2 text-text-sec hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                                          title="Excluir"
                                        >
                                          <X size={14} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : sidebarTab === 'fichamento' ? (
                            <div className="space-y-4 animate-in fade-in flex flex-col h-full">
                                <div className="bg-bg rounded-lg border border-border p-3 flex items-center gap-2 text-text-sec text-xs">
                                  <FileText size={16} />
                                  <p>Este fichamento contém apenas os trechos de texto destacados e notas, ordenados por página.</p>
                                </div>
                                
                                <textarea 
                                  value={fichamentoText}
                                  readOnly
                                  className="flex-1 w-full bg-bg border border-border rounded-lg p-3 text-sm text-text resize-none focus:outline-none focus:border-brand custom-scrollbar leading-relaxed"
                                  placeholder="Nenhum trecho de texto destacado encontrado..."
                                />
                                
                                <div className="flex gap-2 shrink-0">
                                  <button 
                                    onClick={handleCopyFichamento}
                                    disabled={!fichamentoText}
                                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-surface border border-border rounded-lg hover:bg-white/5 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    <Copy size={16} />
                                    Copiar
                                  </button>
                                  <button 
                                    onClick={handleDownloadFichamento}
                                    disabled={!fichamentoText}
                                    className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-brand text-bg rounded-lg hover:brightness-110 transition-colors text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    <Download size={16} />
                                    Baixar .txt
                                  </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-6 animate-in fade-in">
                                {/* Page Numbering Settings */}
                                <div className="space-y-3">
                                    <h4 className="text-xs text-text-sec uppercase font-bold tracking-wider flex items-center gap-2">
                                        <Hash size={14} /> Paginação
                                    </h4>
                                    <div className="flex justify-between items-center bg-bg p-2 rounded-lg border border-border">
                                        <label className="text-sm text-text">Página Inicial</label>
                                        <input 
                                            type="number" 
                                            min="1" 
                                            value={pageOffset} 
                                            onChange={(e) => setPageOffset(Math.max(1, parseInt(e.target.value) || 1))} 
                                            className="bg-transparent border-b border-border w-16 text-right focus:outline-none focus:border-brand" 
                                        />
                                    </div>
                                    <p className="text-xs text-text-sec">Ajusta a numeração exibida (ex: se o artigo começa na pág. 180).</p>
                                </div>

                                <div className="w-full h-px bg-border my-2"></div>

                                {/* Color Settings */}
                                <div className="space-y-3">
                                    <h4 className="text-xs text-text-sec uppercase font-bold tracking-wider flex items-center gap-2">
                                        <PaintBucket size={14} /> Leitura
                                    </h4>

                                    {/* Theme Presets */}
                                    <div className="grid grid-cols-3 gap-2 mb-2">
                                      <button 
                                        onClick={() => { setPageColor('#ffffff'); setTextColor('#000000'); }}
                                        className="flex flex-col items-center gap-1 p-2 rounded-lg border border-border hover:border-brand bg-white text-black transition-all"
                                        title="Tema Claro"
                                      >
                                        <div className="w-6 h-6 rounded-full border border-gray-200 flex items-center justify-center font-serif font-bold text-xs bg-white text-black">A</div>
                                        <span className="text-[10px] font-medium text-gray-900">Claro</span>
                                      </button>

                                      <button 
                                        onClick={() => { setPageColor('#0f172a'); setTextColor('#ffffff'); }}
                                        className="flex flex-col items-center gap-1 p-2 rounded-lg border border-border hover:border-brand bg-[#0f172a] text-white transition-all"
                                        title="Tema Escuro (Azulado)"
                                      >
                                        <div className="w-6 h-6 rounded-full border border-gray-700 flex items-center justify-center font-serif font-bold text-xs bg-[#0f172a] text-white">A</div>
                                        <span className="text-[10px] font-medium text-gray-200">Escuro</span>
                                      </button>

                                      <button 
                                        onClick={() => { setPageColor('#000000'); setTextColor('#ffffff'); }}
                                        className="flex flex-col items-center gap-1 p-2 rounded-lg border border-border hover:border-brand bg-black text-white transition-all"
                                        title="Tema OLED"
                                      >
                                        <div className="w-6 h-6 rounded-full border border-gray-800 flex items-center justify-center font-serif font-bold text-xs bg-black text-white">A</div>
                                        <span className="text-[10px] font-medium text-gray-200">OLED</span>
                                      </button>
                                    </div>

                                    <div className="flex justify-between items-center bg-bg p-2 rounded-lg border border-border">
                                        <label className="text-sm text-text">Fundo</label>
                                        <input type="color" value={pageColor} onChange={(e) => setPageColor(e.target.value)} className="bg-transparent border-0 w-8 h-8 cursor-pointer" />
                                    </div>
                                    <div className="flex justify-between items-center bg-bg p-2 rounded-lg border border-border">
                                        <label className="text-sm text-text">Texto</label>
                                        <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="bg-transparent border-0 w-8 h-8 cursor-pointer" />
                                    </div>
                                    <button 
                                      onClick={() => { setPageColor('#ffffff'); setTextColor('#000000'); }}
                                      className="w-full text-xs text-text-sec hover:text-text border border-border rounded py-1"
                                    >
                                      Resetar Cores
                                    </button>
                                </div>

                                <div className="space-y-3">
                                    <h4 className="text-xs text-text-sec uppercase font-bold tracking-wider flex items-center gap-2">
                                        <Highlighter size={14} /> Destaque
                                    </h4>
                                    <div className="flex justify-between items-center bg-bg p-2 rounded-lg border border-border">
                                        <label className="text-sm text-text">Cor</label>
                                        <div className="flex gap-1">
                                            {['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#a78bfa'].map(c => (
                                                <button 
                                                    key={c}
                                                    onClick={() => setHighlightColor(c)}
                                                    className={`w-6 h-6 rounded-full border border-border ${highlightColor === c ? 'ring-2 ring-text' : ''}`}
                                                    style={{ backgroundColor: c }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                    <div className="bg-bg p-2 rounded-lg border border-border">
                                        <div className="flex justify-between mb-1">
                                            <label className="text-sm text-text">Opacidade</label>
                                            <span className="text-xs text-text-sec">{Math.round(highlightOpacity * 100)}%</span>
                                        </div>
                                        <input 
                                            type="range" min="0.1" max="1" step="0.1" 
                                            value={highlightOpacity} 
                                            onChange={(e) => setHighlightOpacity(parseFloat(e.target.value))}
                                            className="w-full accent-brand"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <h4 className="text-xs text-text-sec uppercase font-bold tracking-wider flex items-center gap-2">
                                        <Pen size={14} /> Caneta
                                    </h4>
                                    <div className="flex justify-between items-center bg-bg p-2 rounded-lg border border-border">
                                        <label className="text-sm text-text">Cor</label>
                                        <input type="color" value={inkColor} onChange={(e) => setInkColor(e.target.value)} className="bg-transparent border-0 w-8 h-8 cursor-pointer" />
                                    </div>
                                    <div className="bg-bg p-2 rounded-lg border border-border">
                                        <div className="flex justify-between mb-1">
                                            <label className="text-sm text-text">Espessura</label>
                                            <span className="text-xs text-text-sec">{inkStrokeWidth}px</span>
                                        </div>
                                        <input 
                                            type="range" min="1" max="50" step="1" 
                                            value={inkStrokeWidth} 
                                            onChange={(e) => setInkStrokeWidth(parseInt(e.target.value))}
                                            className="w-full accent-brand"
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        )}

        {/* FLOATING ACTION BAR (THE ISLAND) */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
             {/* The Island */}
             <div className="flex items-center gap-3 p-2 rounded-full bg-black border border-white/20 shadow-2xl pointer-events-auto scale-100 transition-all hover:scale-105 text-white">
                
                {/* Tools Group */}
                <div className="flex items-center gap-1 pr-2 border-r border-white/20">
                    <button 
                        onClick={() => setActiveTool('cursor')}
                        className={`p-2 rounded-full transition-colors ${activeTool === 'cursor' ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
                        title="Selecionar Texto"
                    >
                        <MousePointer2 size={20} />
                    </button>
                    <button 
                        onClick={() => setActiveTool('text')}
                        className={`p-2 rounded-full transition-colors ${activeTool === 'text' ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
                        title="Nota de Texto"
                    >
                        <Type size={20} />
                    </button>
                    <button 
                        onClick={() => setActiveTool('ink')}
                        className={`p-2 rounded-full transition-colors ${activeTool === 'ink' ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
                        title="Desenhar"
                    >
                        <Pen size={20} />
                    </button>
                    <button 
                        onClick={() => setActiveTool('eraser')}
                        className={`p-2 rounded-full transition-colors ${activeTool === 'eraser' ? 'bg-white text-black shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
                        title="Borracha"
                    >
                        <Eraser size={20} />
                    </button>
                </div>

                {/* Page Navigation Group (NEW) */}
                <div className="flex items-center gap-1 pr-2 border-r border-white/20">
                    <button 
                        onClick={() => jumpToPage(currentPageNumber - 1)}
                        className="p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
                        title="Página Anterior"
                        disabled={currentPageNumber <= 1}
                    >
                        <ChevronUp size={16} />
                    </button>
                    
                    <form onSubmit={handlePageSubmit} className="flex items-center justify-center min-w-[60px]">
                        {isEditingPage ? (
                            <input 
                                autoFocus
                                type="text"
                                value={tempPageInput}
                                onChange={(e) => setTempPageInput(e.target.value)}
                                onBlur={() => {
                                    setIsEditingPage(false);
                                    handlePageSubmit({ preventDefault: () => {} } as any);
                                }}
                                className="w-10 bg-white/20 text-white text-center rounded text-sm font-mono outline-none border border-white/30"
                            />
                        ) : (
                            <button 
                                type="button"
                                onClick={() => {
                                    setTempPageInput(currentPageNumber.toString());
                                    setIsEditingPage(true);
                                }}
                                className="text-sm font-mono text-white hover:bg-white/10 px-1 rounded transition-colors"
                            >
                                {currentPageNumber}
                            </button>
                        )}
                        <span className="text-xs text-gray-500 mx-1">/</span>
                        <span className="text-xs text-gray-400">{numPages}</span>
                    </form>

                    <button 
                        onClick={() => jumpToPage(currentPageNumber + 1)}
                        className="p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
                        title="Próxima Página"
                        disabled={currentPageNumber >= numPages}
                    >
                        <ChevronDown size={16} />
                    </button>
                </div>

                {/* Zoom Group */}
                <div className="flex items-center gap-1">
                    <button 
                        onClick={() => scale > 0.5 && setScale(s => s - 0.2)}
                        className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
                    >
                        <ZoomOut size={18} />
                    </button>
                    <span className="text-xs font-mono w-10 text-center text-white font-medium">
                        {Math.round(scale * 100)}%
                    </span>
                    <button 
                        onClick={() => scale < 4 && setScale(s => s + 0.2)}
                        className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
                    >
                        <ZoomIn size={18} />
                    </button>
                    <button
                        onClick={handleFitWidth}
                        className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
                        title="Ajustar à Largura"
                    >
                        <MoveHorizontal size={18} />
                    </button>
                </div>

             </div>
        </div>

        {/* PDF Pages Container */}
        <div 
            className="flex-1 overflow-auto bg-gray-100/50 relative flex justify-center" 
            ref={containerRef}
            onScroll={handleScroll}
            onClick={(e) => {
              if (activeTool === 'text') {
                  const target = e.target as HTMLElement;
                  // If clicking empty space between pages (gray background)
                  if (target === containerRef.current) {
                      // Do nothing
                  }
              }
            }}
            style={{ overflowAnchor: 'none' }} // PREVENTS SCROLL JUMPING ON DOM CHANGES
        >
            {/* Floating Selection Menu - MOVED INSIDE SCROLL CONTAINER */}
            {selection && (
              <div 
                className="absolute z-50 flex flex-col gap-1 animate-in fade-in zoom-in duration-200"
                style={{ 
                  left: selection.popupX,
                  top: selection.popupY,
                  transform: 'translateX(-50%)'
                }}
              >
                <div className="bg-surface shadow-2xl rounded-xl p-1.5 flex items-center gap-1 border border-border">
                    <button 
                      onClick={createHighlight}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-white/10 rounded-lg text-sm font-medium text-text transition-colors"
                    >
                      <Highlighter size={16} className="text-yellow-400" />
                      Destacar
                    </button>
                    <div className="w-px h-6 bg-border mx-1"></div>
                    <button 
                      onClick={() => setSelection(null)}
                      className="p-2 hover:bg-red-500/10 text-text-sec hover:text-red-500 rounded-lg transition-colors"
                    >
                      <X size={16} />
                    </button>
                </div>
                {/* Arrow Pointer */}
                {selection.position === 'top' ? (
                   <div className="w-3 h-3 bg-surface border-b border-r border-border transform rotate-45 absolute -bottom-1.5 left-1/2 -translate-x-1/2"></div>
                ) : (
                   <div className="w-3 h-3 bg-surface border-t border-l border-border transform rotate-45 absolute -top-1.5 left-1/2 -translate-x-1/2"></div>
                )}
              </div>
            )}

          <div className="py-8 md:py-10 px-2 md:px-0">
            {Array.from({ length: numPages }, (_, i) => (
              <PdfPage 
                key={i + 1}
                pageNumber={i + 1}
                pdfDoc={pdfDoc!}
                currentScale={scale}
                renderScale={RENDER_SCALE}
                filterValues={filterValues}
                annotations={annotations.filter(a => a.page === i + 1)}
                activeTool={activeTool}
                inkColor={inkColor}
                inkStrokeWidth={inkStrokeWidth}
                inkOpacity={inkOpacity}
                onPageClick={() => {}} // Legacy prop unused for new notes
                onAddNote={handleAddNote}
                onDeleteAnnotation={handleDeleteAnnotation}
                onAddInk={addInkAnnotation}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};