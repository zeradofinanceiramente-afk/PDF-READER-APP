import React, { useEffect, useState } from 'react';
import { listDriveContents } from '../services/driveService';
import { DriveFile } from '../types';
import { FileText, Loader2, Search, LayoutGrid, List as ListIcon, AlertTriangle, Menu, Folder, ChevronRight, Home, HardDrive, Users, Star } from 'lucide-react';

interface Props {
  accessToken: string;
  onSelectFile: (file: DriveFile) => void;
  onLogout: () => void;
  onAuthError: () => void;
  onToggleMenu: () => void;
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

const SECTIONS = [
  { id: 'root', name: 'Meu Drive', icon: HardDrive },
  { id: 'shared-with-me', name: 'Compartilhados', icon: Users },
  { id: 'starred', name: 'Com Estrela', icon: Star },
];

export const DriveBrowser: React.FC<Props> = ({ accessToken, onSelectFile, onAuthError, onToggleMenu }) => {
  const [currentFolder, setCurrentFolder] = useState<BreadcrumbItem>(SECTIONS[0]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<DriveFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    
    setSearch('');

    listDriveContents(accessToken, currentFolder.id)
      .then(data => {
        if (mounted) {
          const sorted = data.sort((a, b) => {
            const isFolderA = a.mimeType === 'application/vnd.google-apps.folder';
            const isFolderB = b.mimeType === 'application/vnd.google-apps.folder';
            
            if (isFolderA && !isFolderB) return -1;
            if (!isFolderA && isFolderB) return 1;
            return a.name.localeCompare(b.name);
          });
          
          setFiles(sorted);
          setFilteredFiles(sorted);
        }
      })
      .catch(err => {
        if (mounted) {
          console.error(err);
          if (err.message === "Unauthorized" || err.message.includes("401")) {
            onAuthError();
          } else {
            setError(err.message);
          }
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [accessToken, currentFolder.id, onAuthError]);

  useEffect(() => {
    const results = files.filter(f => f.name.toLowerCase().includes(search.toLowerCase()));
    setFilteredFiles(results);
  }, [search, files]);

  const handleSectionClick = (sectionId: string) => {
    const section = SECTIONS.find(s => s.id === sectionId);
    if (section) {
      setCurrentFolder(section);
      setBreadcrumbs([]);
    }
  };

  const handleFolderClick = (folder: DriveFile) => {
    setBreadcrumbs(prev => [...prev, currentFolder]);
    setCurrentFolder({ id: folder.id, name: folder.name });
  };

  const handleBreadcrumbClick = (item: BreadcrumbItem, index: number) => {
    // Check if clicked item is one of the root sections
    if (SECTIONS.some(s => s.id === item.id)) {
      setBreadcrumbs([]);
      setCurrentFolder(item);
      return;
    }

    const targetIndex = breadcrumbs.findIndex(b => b.id === item.id);
    if (targetIndex !== -1) {
      setBreadcrumbs(breadcrumbs.slice(0, targetIndex));
      setCurrentFolder(item);
    }
  };

  const handleItemClick = (file: DriveFile) => {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      handleFolderClick(file);
    } else {
      onSelectFile(file);
    }
  };

  // Determine current active section for sidebar highlighting
  // If currentFolder is a section root, easy.
  // If breadcrumbs exist, the first item in breadcrumbs is likely the section root.
  const activeSectionId = breadcrumbs.length > 0 ? breadcrumbs[0].id : currentFolder.id;

  if (error) {
    return (
      <div className="flex flex-col h-full bg-bg text-text p-10 items-center justify-center text-center">
        <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 mb-4">
          <AlertTriangle size={32} />
        </div>
        <h3 className="text-xl font-semibold mb-2">Erro ao carregar arquivos</h3>
        <p className="text-text-sec mb-6 max-w-md">{error}</p>
        <button 
          onClick={() => window.location.reload()}
          className="px-6 py-2 bg-surface border border-border rounded-full hover:bg-white/5 transition"
        >
          Tentar Novamente
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-bg text-text overflow-hidden">
      
      {/* Drive Sidebar (Desktop) */}
      <div className="hidden md:flex flex-col w-64 bg-surface/30 border-r border-border p-4 gap-2 shrink-0">
        <div className="text-xs font-bold text-text-sec uppercase tracking-wider mb-2 px-3">Organização</div>
        {SECTIONS.map(section => {
          const Icon = section.icon;
          const isActive = activeSectionId === section.id;
          return (
            <button
              key={section.id}
              onClick={() => handleSectionClick(section.id)}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                isActive 
                  ? 'bg-brand/10 text-brand' 
                  : 'text-text-sec hover:text-text hover:bg-surface'
              }`}
            >
              <Icon size={18} />
              <span>{section.name}</span>
            </button>
          );
        })}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
        <div className="flex flex-col gap-4 p-4 md:p-8 pb-0">
          
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button onClick={onToggleMenu} className="custom-menu-btn md:hidden p-2 -ml-2 text-text-sec hover:text-text rounded-full hover:bg-surface transition">
                <Menu size={24} />
              </button>
              <h2 className="text-2xl md:text-3xl font-normal tracking-tight truncate">{currentFolder.name}</h2>
            </div>
            
            <div className="flex items-center gap-3 w-full md:w-auto">
              <div className="relative flex-1 md:w-72 group">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-sec group-focus-within:text-brand transition-colors" size={18} />
                <input 
                  type="text" 
                  placeholder="Pesquisar..." 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full bg-surface border border-border focus:border-brand rounded-full py-2 pl-10 pr-4 text-sm outline-none transition-all placeholder:text-text-sec text-text"
                />
              </div>

              <div className="bg-surface border border-border p-1 rounded-full flex shrink-0">
                <button 
                  onClick={() => setViewMode('grid')}
                  className={`p-2 rounded-full transition-all ${viewMode === 'grid' ? 'bg-bg text-brand shadow-sm' : 'text-text-sec hover:text-text'}`}
                >
                  <LayoutGrid size={16} />
                </button>
                <button 
                  onClick={() => setViewMode('list')}
                  className={`p-2 rounded-full transition-all ${viewMode === 'list' ? 'bg-bg text-brand shadow-sm' : 'text-text-sec hover:text-text'}`}
                >
                  <ListIcon size={16} />
                </button>
              </div>
            </div>
          </div>

          {/* Mobile Tabs */}
          <div className="md:hidden flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none -mx-4 px-4">
             {SECTIONS.map(section => {
                const Icon = section.icon;
                const isActive = activeSectionId === section.id;
                return (
                  <button
                    key={section.id}
                    onClick={() => handleSectionClick(section.id)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap border transition-all ${
                      isActive 
                        ? 'bg-brand/10 border-brand/20 text-brand' 
                        : 'bg-surface border-border text-text-sec'
                    }`}
                  >
                    <Icon size={14} />
                    <span>{section.name}</span>
                  </button>
                );
             })}
          </div>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-2 scrollbar-none text-sm min-h-[32px]">
             {/* Always show Root Section first in breadcrumb if we are deep */}
             {breadcrumbs.length > 0 && (
               <>
                  <button 
                    onClick={() => handleBreadcrumbClick(breadcrumbs[0], 0)}
                    className="flex items-center gap-1 px-2 py-1 rounded hover:bg-surface transition-colors text-text-sec"
                  >
                    {SECTIONS.some(s => s.id === breadcrumbs[0].id) ? (
                        <>
                           {(() => {
                               const S = SECTIONS.find(s => s.id === breadcrumbs[0].id);
                               const Icon = S ? S.icon : Home;
                               return <Icon size={14} />;
                           })()}
                           <span>{breadcrumbs[0].name}</span>
                        </>
                    ) : (
                        <span>{breadcrumbs[0].name}</span>
                    )}
                  </button>
                  <ChevronRight size={14} className="text-text-sec shrink-0" />
               </>
             )}
             
             {/* If current is root section and no breadcrumbs, show simple label? */}
             {breadcrumbs.length === 0 && (
                 <div className="flex items-center gap-1 px-2 py-1 text-text font-medium">
                     {(() => {
                         const S = SECTIONS.find(s => s.id === currentFolder.id);
                         const Icon = S ? S.icon : Home;
                         return <Icon size={14} />;
                     })()}
                     <span>{currentFolder.name}</span>
                 </div>
             )}

            {/* Intermediary crumbs (skip 0 because we handled it above manually for icon support) */}
            {breadcrumbs.slice(1).map((crumb, idx) => (
              <React.Fragment key={crumb.id}>
                <button 
                  onClick={() => handleBreadcrumbClick(crumb, idx + 1)}
                  className="px-2 py-1 rounded hover:bg-surface transition-colors text-text-sec whitespace-nowrap"
                >
                  {crumb.name}
                </button>
                <ChevronRight size={14} className="text-text-sec shrink-0" />
              </React.Fragment>
            ))}
            
            {/* Current leaf */}
            {breadcrumbs.length > 0 && (
                <span className="px-2 py-1 text-text font-medium whitespace-nowrap">{currentFolder.name}</span>
            )}
          </div>
        </div>

        {/* File List Content */}
        <div className="flex-1 overflow-y-auto px-4 md:px-8 pb-20 custom-scrollbar">
          {loading && (
            <div className="flex flex-col h-full items-center justify-center gap-3 opacity-50">
              <Loader2 className="animate-spin h-8 w-8 text-brand" />
              <span className="text-sm">Carregando {currentFolder.name.toLowerCase()}...</span>
            </div>
          )}

          {!loading && !error && (
             <>
               {filteredFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-64 text-text-sec/50 gap-4">
                     <Folder size={48} strokeWidth={1} />
                     <p>Esta pasta está vazia.</p>
                  </div>
               ) : (
                 <div className={viewMode === 'grid' ? "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-4 pb-10" : "flex flex-col gap-2 pb-10"}>
                    
                    {/* Back Button (Virtual) - Only if we have history and not searching */}
                    {breadcrumbs.length > 0 && search === '' && (
                        viewMode === 'grid' ? (
                          <button
                            onClick={() => {
                              const prev = breadcrumbs[breadcrumbs.length - 1];
                              // Logic to go back
                              const newCrumbs = breadcrumbs.slice(0, -1);
                              setBreadcrumbs(newCrumbs);
                              setCurrentFolder(prev);
                            }}
                            className="flex flex-col p-4 rounded-2xl bg-surface/50 border border-border border-dashed hover:border-text-sec transition-all text-left items-center justify-center min-h-[160px] group"
                          >
                              <div className="h-10 w-10 rounded-full bg-surface flex items-center justify-center text-text-sec mb-2 group-hover:scale-110 transition-transform">
                                <ChevronRight size={20} className="rotate-180"/>
                              </div>
                              <span className="text-sm text-text-sec">Voltar</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                                const prev = breadcrumbs[breadcrumbs.length - 1];
                                setBreadcrumbs(breadcrumbs.slice(0, -1));
                                setCurrentFolder(prev);
                            }}
                            className="flex items-center gap-4 p-3 rounded-xl bg-surface/30 hover:bg-surface transition-all text-left border border-border border-dashed text-text-sec"
                          >
                              <div className="h-10 w-10 flex items-center justify-center">
                                  <ChevronRight size={20} className="rotate-180"/>
                              </div>
                              <span>Voltar</span>
                          </button>
                        )
                    )}

                    {filteredFiles.map(file => {
                      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
                      
                      if (viewMode === 'grid') {
                        return (
                          <button
                            key={file.id}
                            onClick={() => handleItemClick(file)}
                            className="group flex flex-col p-4 rounded-2xl bg-surface hover:brightness-110 transition-all border border-border hover:border-brand/30 text-left relative overflow-hidden"
                          >
                            <div className="flex items-center justify-between mb-4 w-full">
                              <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${isFolder ? 'bg-blue-500/10 text-blue-400' : 'bg-brand/10 text-brand'}`}>
                                {isFolder ? <Folder size={20} fill="currentColor" className="opacity-50" /> : <FileText size={20} />}
                              </div>
                            </div>
                            
                            <div className="min-w-0 z-10 w-full">
                              <p className="font-medium truncate text-text group-hover:text-brand transition-colors text-sm md:text-base" title={file.name}>
                                {file.name}
                              </p>
                              <p className="text-xs text-text-sec mt-1">
                                {isFolder ? 'Pasta' : 'PDF'}
                              </p>
                            </div>

                            {file.thumbnailLink && !isFolder && (
                              <div className="absolute right-0 bottom-0 w-24 h-24 opacity-10 group-hover:opacity-20 transition-opacity translate-x-4 translate-y-4 rotate-12 pointer-events-none">
                                <img src={file.thumbnailLink} alt="" className="w-full h-full object-cover" />
                              </div>
                            )}
                          </button>
                        );
                      } else {
                        return (
                          <button
                            key={file.id}
                            onClick={() => handleItemClick(file)}
                            className="group flex items-center gap-4 p-3 rounded-xl bg-surface hover:brightness-110 transition-all text-left border border-border hover:border-brand/30"
                          >
                            <div className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 ${isFolder ? 'bg-blue-500/10 text-blue-400' : 'bg-brand/10 text-brand'}`}>
                              {isFolder ? <Folder size={20} fill="currentColor" className="opacity-50"/> : <FileText size={20} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate text-text">{file.name}</p>
                            </div>
                            <span className="text-sm text-text-sec hidden sm:block w-24">
                              {isFolder ? 'Pasta' : 'PDF'}
                            </span>
                            <div className="w-8 h-8 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 bg-bg">
                              <ChevronRight size={14} className="text-text-sec"/>
                            </div>
                          </button>
                        );
                      }
                    })}
                 </div>
               )}
             </>
          )}
        </div>
      </div>
    </div>
  );
};