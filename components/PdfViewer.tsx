import React, { useEffect, useRef, useState, useMemo } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, rgb } from 'pdf-lib';
import { Annotation, DriveFile } from '../types';
import { saveAnnotation, loadAnnotations } from '../services/storageService';
import { downloadDriveFile, uploadFileToDrive, deleteDriveFile } from '../services/driveService';
import { ArrowLeft, Highlighter, Loader2, X, Type, List, MousePointer2, Save, ScanLine, ZoomIn, ZoomOut, Menu, PaintBucket, Sliders, MoveHorizontal, Pen, Eraser, Copy, Download, FileText } from 'lucide-react';

// Explicitly set worker to specific version to match package.json (5.4.449)
GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.449/build/pdf.worker.min.mjs`;

interface Props {
  accessToken?: string | null;
  fileId: string;
  fileName: string;
  fileParents?: string[];
  uid: string;
  onBack: () => void;
  fileBlob?: Blob;
  isPopup?: boolean;
}

interface SelectionState {
  page: number;
  text: string;
  // Position relative to the scrolling container
  popupX: number;
  popupY: number;
  // Rects relative to the page element (for saving)
  relativeRects: { x: number; y: number; width: number; height: number }[];
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
  
  textContent.items.forEach((item: any) => {
    if (!item.str || item.str.trim().length === 0) return;

    const tx = item.transform;
    const fontHeight = Math.sqrt(tx[3] * tx[3] + tx[2] * tx[2]);
    const fontSize = fontHeight * viewport.scale;

    const [x, y] = viewport.convertToViewportPoint(tx[4], tx[5]);

    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.left = `${x}px`;
    span.style.top = `${y - fontSize}px`; 
    span.style.fontSize = `${fontSize}px`;
    
    // Check for explicit font in PDF styles to respect TimesNewRoman or other specific fonts
    if (textContent.styles && item.fontName && textContent.styles[item.fontName]) {
      span.style.fontFamily = textContent.styles[item.fontName].fontFamily;
    } else {
      // Fallback
      span.style.fontFamily = "'Google Sans', 'Inter', sans-serif";
    }

    span.style.position = 'absolute';
    span.style.color = 'transparent';
    span.style.whiteSpace = 'pre';
    span.style.cursor = 'text';
    span.style.transformOrigin = '0% 0%';
    span.style.lineHeight = '1';
    span.style.pointerEvents = 'all';

    const angle = Math.atan2(tx[1], tx[0]);
    if (angle !== 0) {
      span.style.transform = `rotate(${angle}rad)`;
    }

    container.appendChild(span);
  });
};

// --- Sub-Component: Individual Page Renderer ---
interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  filterValues: string;
  annotations: Annotation[];
  activeTool: 'cursor' | 'text' | 'ink' | 'eraser';
  inkColor: string;
  inkStrokeWidth: number;
  inkOpacity: number;
  onPageClick: (page: number, x: number, y: number) => void;
  onDeleteAnnotation: (annotation: Annotation) => void; // Fixed: Now expects Annotation object
  onAddInk: (ann: Annotation) => void;
}

const PdfPage: React.FC<PdfPageProps> = ({ 
  pdfDoc, 
  pageNumber, 
  scale, 
  filterValues, 
  annotations,
  activeTool,
  inkColor,
  inkStrokeWidth,
  inkOpacity,
  onPageClick,
  onDeleteAnnotation,
  onAddInk
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null); // Ref to track current render task
  
  // States
  const [rendered, setRendered] = useState(false);
  const [hasText, setHasText] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  
  // Optimization: Cache page proxy to avoid async getPage calls on zoom
  const [pageProxy, setPageProxy] = useState<any>(null);

  // Ink State
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentPoints, setCurrentPoints] = useState<number[][]>([]);

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

  // 3. Calculate Dimensions synchronously (fast zoom)
  const pageDimensions = useMemo(() => {
    if (!pageProxy) return null;
    const viewport = pageProxy.getViewport({ scale });
    return { width: viewport.width, height: viewport.height };
  }, [pageProxy, scale]);

  // 4. Render Content (Only when Visible AND Dimensions set)
  useEffect(() => {
    if (!isVisible || !pageDimensions || !pageProxy || !canvasRef.current || !textLayerRef.current) return;
    
    let active = true;

    const render = async () => {
      try {
        const viewport = pageProxy.getViewport({ scale });
        
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
        // Ignore rendering cancelled errors as they are expected when zooming/scrolling fast
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
  }, [pageProxy, scale, isVisible, pageDimensions]);

  const handleContainerClick = (e: React.MouseEvent) => {
    if (activeTool !== 'text' || !pageContainerRef.current) return;
    if ((e.target as HTMLElement).closest('.annotation-item')) return;

    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    onPageClick(pageNumber, x, y);
  };

  // --- Ink Handling ---
  const handlePointerDown = (e: React.PointerEvent) => {
    if (activeTool !== 'ink' || !pageContainerRef.current) return;
    e.preventDefault(); 
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setIsDrawing(true);
    setCurrentPoints([[x, y]]);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDrawing || activeTool !== 'ink' || !pageContainerRef.current) return;
    e.preventDefault();

    const rect = pageContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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
        points: currentPoints,
        color: inkColor,
        strokeWidth: inkStrokeWidth,
        opacity: inkOpacity
      });
    }
    setCurrentPoints([]);
  };

  // Use calculated dimensions or fallback to min-height to allow intersection observer to work
  const widthStyle = pageDimensions ? `${pageDimensions.width}px` : '100%';
  const heightStyle = pageDimensions ? `${pageDimensions.height}px` : `${800 * scale}px`;

  return (
    <div 
      ref={pageContainerRef}
      className={`pdf-page relative shadow-lg bg-white mb-4 md:mb-8 mx-auto transition-cursor ${activeTool === 'text' ? 'cursor-text' : activeTool === 'ink' ? 'cursor-crosshair touch-none' : activeTool === 'eraser' ? 'cursor-[url(https://cdn-icons-png.flaticon.com/32/2661/2661282.png),_pointer]' : ''}`}
      data-page-number={pageNumber}
      style={{ 
        width: widthStyle, 
        height: heightStyle
      }}
      onClick={handleContainerClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      {!hasText && rendered && isVisible && (
         <div className="absolute -top-6 left-0 flex items-center gap-1 text-xs text-text-sec opacity-70">
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

      {/* Annotations Layer */}
      {isVisible && (
        <div className="absolute inset-0 pointer-events-none">
          {/* SVG Layer for Ink */}
          <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 15 }}>
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
                  cursor: activeTool === 'eraser' ? 'pointer' : 'none'
                }}
                onClick={(e) => {
                  if (activeTool === 'eraser' && ann.id) {
                    e.stopPropagation();
                    onDeleteAnnotation(ann); // Fixed: Pass annotation object
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
          </svg>

          {annotations.map((ann, i) => {
            const isHighlight = ann.type === 'highlight';
            
            if (isHighlight) {
              return (
                <div 
                  key={ann.id || i}
                  id={`ann-${ann.id}`}
                  className="annotation-item absolute mix-blend-multiply group pointer-events-auto"
                  style={{
                    left: ann.bbox[0],
                    top: ann.bbox[1],
                    width: ann.bbox[2],
                    height: ann.bbox[3],
                    backgroundColor: ann.color || '#facc15',
                    opacity: ann.opacity ?? 0.4,
                    pointerEvents: activeTool === 'cursor' ? 'none' : 'auto',
                    cursor: activeTool === 'eraser' ? 'pointer' : 'default'
                  }}
                  onClick={(e) => {
                    if (activeTool === 'eraser' && ann.id) {
                      e.stopPropagation();
                      onDeleteAnnotation(ann); // Fixed: Pass annotation object
                    }
                  }}
                />
              );
            } else if (ann.type === 'note') {
              return (
                <div
                  key={ann.id || i}
                  id={`ann-${ann.id}`}
                  className="annotation-item absolute z-20 group pointer-events-auto"
                  style={{
                    left: ann.bbox[0],
                    top: ann.bbox[1],
                    maxWidth: '200px'
                  }}
                >
                  <div 
                    className="bg-yellow-100 text-gray-900 text-sm p-2 rounded shadow-md border border-yellow-300 relative hover:scale-105 transition-transform"
                    style={{ backgroundColor: ann.color || '#fef9c3' }}
                  >
                    <p className="whitespace-pre-wrap break-words font-medium leading-tight">{ann.text}</p>
                    
                    {ann.id && !ann.id.startsWith('temp') && (
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteAnnotation(ann); // Fixed: Pass annotation object
                        }}
                        className="absolute -top-2 -right-2 bg-red-500 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-sm pointer-events-auto cursor-pointer"
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
  );
};

// --- Main Component ---

export const PdfViewer: React.FC<Props> = ({ accessToken, fileId, fileName, fileParents, uid, onBack, fileBlob, isPopup }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [originalBlob, setOriginalBlob] = useState<Blob | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [scale, setScale] = useState(1.0); // Start with 1.0, will auto-adjust
  
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
  
  // Ink Settings
  const [inkColor, setInkColor] = useState("#22c55e"); // Green by default
  const [inkStrokeWidth, setInkStrokeWidth] = useState(20); // 20px by default
  const [inkOpacity, setInkOpacity] = useState(0.5); // 50% opacity by default

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
    // When highlighting multiline text, we get multiple Annotation objects (one per line/rect).
    // All of them contain the full text. We need to filter duplicates based on content and page.
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
      .map(a => `Página ${a.page}\n${a.text}`)
      .join('\n\n');
  }, [annotations]);

  // Sidebar List Generation (Annotations Tab) - Same Deduplication Logic
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

  // Helper to delete an annotation
  // If it's a text highlight, we delete ALL fragments on that page with the same text to keep visual consistency
  const handleDeleteAnnotation = (target: Annotation) => {
    if (target.type === 'ink' || !target.text) {
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
  };

  // Load PDF
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        setLoading(true);
        let blob: Blob;

        if (fileBlob) {
          blob = fileBlob;
        } else if (accessToken) {
          blob = await downloadDriveFile(accessToken, fileId);
        } else {
          throw new Error("No file source provided");
        }

        if (mounted) setOriginalBlob(blob);

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
      } catch (err) {
        console.error("Error loading PDF:", err);
        alert(`Falha ao carregar PDF. Verifique se o arquivo é válido. (Erro: ${err instanceof Error ? err.message : String(err)})`);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    init();
    return () => { mounted = false; };
  }, [accessToken, fileId, uid, fileBlob]);

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

  // Global Selection Handler (For Highlight)
  useEffect(() => {
    const handleSelectionEnd = (e: Event) => {
      if (activeTool === 'text' || activeTool === 'ink' || activeTool === 'eraser') return;
      if (e.target instanceof Element && e.target.closest('button, input, select, .ui-panel')) return;

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
        
        // Calculate coords relative to the container content area (including scroll)
        // This ensures the popup scrolls WITH the text
        const popupX = boundingRect.left - containerRect.left + container.scrollLeft + (boundingRect.width / 2);
        const popupY = boundingRect.bottom - containerRect.top + container.scrollTop + 10;

        const pageRect = pageElement.getBoundingClientRect();
        const relativeRects = rects.map(r => ({
          x: r.left - pageRect.left,
          y: r.top - pageRect.top,
          width: r.width,
          height: r.height
        }));

        setSelection({
          page: pageNum,
          text: text,
          popupX,
          popupY,
          relativeRects
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
  }, [activeTool]);


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
        ],
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

  const createTextNote = async (page: number, x: number, y: number) => {
    const text = window.prompt("Digite sua nota:");
    if (!text || !text.trim()) return;

    setActiveTool('cursor');

    const newAnn: Annotation = {
      id: `temp-note-${Date.now()}-${Math.random()}`,
      page,
      bbox: [x, y, 0, 0],
      type: 'note',
      text: text,
      color: '#fef9c3',
      opacity: 1
    };

    setAnnotations(prev => [...prev, newAnn]);
    saveAnnotationsList([newAnn]);
  };

  const addInkAnnotation = async (ann: Annotation) => {
    // ann already has temp id from PdfPage
    setAnnotations(prev => [...prev, ann]);
    saveAnnotationsList([ann]);
  };

  const saveAnnotationsList = async (anns: Annotation[]) => {
    setIsSaving(true);
    try {
      for (const ann of anns) {
         // We might want to remove the temp ID before saving to Firestore if Firestore generates it,
         // but storageService handles ID mapping.
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
          const rectX = ann.bbox[0] / scale;
          const rectY = ann.bbox[1] / scale;
          const rectW = ann.bbox[2] / scale;
          const rectH = ann.bbox[3] / scale;
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
          const rectX = ann.bbox[0] / scale;
          const rectY = ann.bbox[1] / scale;
          const noteColor = hexToRgb(ann.color || '#fef9c3');
          page.drawRectangle({
            x: rectX,
            y: height - rectY - 20,
            width: 150,
            height: 50,
            color: noteColor,
          });
        } else if (ann.type === 'ink' && ann.points && ann.points.length > 0) {
           // Basic line drawing approximation
           const color = hexToRgb(ann.color || '#ff0000');
           const width = (ann.strokeWidth || 3) / scale; // Use strokeWidth stored in annotation
           
           for (let i = 0; i < ann.points.length - 1; i++) {
             const p1 = ann.points[i];
             const p2 = ann.points[i+1];
             page.drawLine({
               start: { x: p1[0] / scale, y: height - (p1[1] / scale) },
               end: { x: p2[0] / scale, y: height - (p2[1] / scale) },
               thickness: width,
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
          <button 
            onClick={onBack} 
            className="p-2 -ml-2 hover:bg-white/10 rounded-full transition text-text"
            title={isPopup ? "Fechar Janela" : "Voltar"}
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
                                            <span className="text-xs text-text-sec uppercase font-bold tracking-wider">Pág {ann.page}</span>
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
                                {/* Color Settings */}
                                <div className="space-y-3">
                                    <h4 className="text-xs text-text-sec uppercase font-bold tracking-wider flex items-center gap-2">
                                        <PaintBucket size={14} /> Leitura
                                    </h4>
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
            onClick={(e) => {
              if (activeTool === 'text') {
                  const target = e.target as HTMLElement;
                  // If clicking empty space between pages (gray background)
                  if (target === containerRef.current) {
                      // Do nothing
                  }
              }
            }}
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
                {/* Little arrow pointing up */}
                <div className="w-3 h-3 bg-surface border-t border-l border-border transform rotate-45 absolute -top-1.5 left-1/2 -translate-x-1/2"></div>
              </div>
            )}

          <div className="py-8 md:py-10 px-2 md:px-0">
            {Array.from({ length: numPages }, (_, i) => (
              <PdfPage 
                key={i + 1}
                pageNumber={i + 1}
                pdfDoc={pdfDoc!}
                scale={scale}
                filterValues={filterValues}
                annotations={annotations.filter(a => a.page === i + 1)}
                activeTool={activeTool}
                inkColor={inkColor}
                inkStrokeWidth={inkStrokeWidth}
                inkOpacity={inkOpacity}
                onPageClick={(page, x, y) => createTextNote(page, x, y)}
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