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
  const activeSectionId = breadcrumbs.length > 0 ? breadcrumbs[0].id : currentFolder.id;

  if (error) {
    return (
      <div className="flex flex-col h-full bg-bg text-text p-10 items-center justify-center text-center">
        <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 mb-6">
          <AlertTriangle size={40} />
        </div>
        <h3 className="text-2xl font-semibold mb-3">Erro ao carregar arquivos</h3>
        <p className="text-text-sec mb-8 max-w-md text-lg">{error}</p>
        <button 
          onClick={() => window.location.reload()}
          className="px-8 py-3 bg-surface border border-border rounded-full hover:bg-white/5 transition text-lg"
        >
          Tentar Novamente
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-bg text-text overflow-hidden">
      
      {/* Drive Sidebar (Desktop) - Kept existing but simplified, though Hamburger is primary now */}
      <div className="hidden md:flex flex-col w-80 bg-surface/30 border-r border-border p-6 gap-3 shrink-0">
        <div className="text-sm font-bold text-text-sec uppercase tracking-wider mb-2 px-4">Organização</div>
        {SECTIONS.map(section => {
          const Icon = section.icon;
          const isActive = activeSectionId === section.id;
          return (
            <button
              key={section.id}
              onClick={() => handleSectionClick(section.id)}
              className={`flex items-center gap-4 px-5 py-4 rounded-2xl text-base font-medium transition-all ${
                isActive 
                  ? 'bg-brand/10 text-brand' 
                  : 'text-text-sec hover:text-text hover:bg-surface'
              }`}
            >
              <Icon size={22} />
              <span>{section.name}</span>
            </button>
          );
        })}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
        <div className="flex flex-col gap-6 p-6 md:p-10 pb-0">
          
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <button onClick={onToggleMenu} className="custom-menu-btn p-3 -ml-3 text-text-sec hover:text-text rounded-full hover:bg-surface transition">
                <Menu size={32} />
              </button>
              <h2 className="text-3xl md:text-5xl font-normal tracking-tight truncate">{currentFolder.name}</h2>
            </div>
            
            <div className="flex items-center gap-4 w-full md:w-auto">
              <div className="relative flex-1 md:w-96 group">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-text-sec group-focus-within:text-brand transition-colors" size={20} />
                <input 
                  type="text" 
                  placeholder="Pesquisar..." 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full bg-surface border border-border focus:border-brand rounded-full py-3 pl-12 pr-6 text-base outline-none transition-all placeholder:text-text-sec text-text"
                />
              </div>

              <div className="bg-surface border border-border p-1.5 rounded-full flex shrink-0">
                <button 
                  onClick={() => setViewMode('grid')}
                  className={`p-3 rounded-full transition-all ${viewMode === 'grid' ? 'bg-bg text-brand shadow-sm' : 'text-text-sec hover:text-text'}`}
                >
                  <LayoutGrid size={20} />
                </button>
                <button 
                  onClick={() => setViewMode('list')}
                  className={`p-3 rounded-full transition-all ${viewMode === 'list' ? 'bg-bg text-brand shadow-sm' : 'text-text-sec hover:text-text'}`}
                >
                  <ListIcon size={20} />
                </button>
              </div>
            </div>
          </div>

          {/* Mobile Tabs */}
          <div className="md:hidden flex items-center gap-3 overflow-x-auto pb-2 scrollbar-none -mx-6 px-6">
             {SECTIONS.map(section => {
                const Icon = section.icon;
                const isActive = activeSectionId === section.id;
                return (
                  <button
                    key={section.id}
                    onClick={() => handleSectionClick(section.id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap border transition-all ${
                      isActive 
                        ? 'bg-brand/10 border-brand/20 text-brand' 
                        : 'bg-surface border-border text-text-sec'
                    }`}
                  >
                    <Icon size={16} />
                    <span>{section.name}</span>
                  </button>
                );
             })}
          </div>

          {/* Breadcrumbs - Larger */}
          <div className="flex items-center gap-2 overflow-x-auto pb-4 scrollbar-none text-base min-h-[40px]">
             {breadcrumbs.length > 0 && (
               <>
                  <button 
                    onClick={() => handleBreadcrumbClick(breadcrumbs[0], 0)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-surface transition-colors text-text-sec"
                  >
                    {SECTIONS.some(s => s.id === breadcrumbs[0].id) ? (
                        <>
                           {(() => {
                               const S = SECTIONS.find(s => s.id === breadcrumbs[0].id);
                               const Icon = S ? S.icon : Home;
                               return <Icon size={18} />;
                           })()}
                           <span>{breadcrumbs[0].name}</span>
                        </>
                    ) : (
                        <span>{breadcrumbs[0].name}</span>
                    )}
                  </button>
                  <ChevronRight size={18} className="text-text-sec shrink-0" />
               </>
             )}
             
             {breadcrumbs.length === 0 && (
                 <div className="flex items-center gap-2 px-3 py-1.5 text-text font-medium">
                     {(() => {
                         const S = SECTIONS.find(s => s.id === currentFolder.id);
                         const Icon = S ? S.icon : Home;
                         return <Icon size={18} />;
                     })()}
                     <span>{currentFolder.name}</span>
                 </div>
             )}

            {breadcrumbs.slice(1).map((crumb, idx) => (
              <React.Fragment key={crumb.id}>
                <button 
                  onClick={() => handleBreadcrumbClick(crumb, idx + 1)}
                  className="px-3 py-1.5 rounded-lg hover:bg-surface transition-colors text-text-sec whitespace-nowrap"
                >
                  {crumb.name}
                </button>
                <ChevronRight size={18} className="text-text-sec shrink-0" />
              </React.Fragment>
            ))}
            
            {breadcrumbs.length > 0 && (
                <span className="px-3 py-1.5 text-text font-medium whitespace-nowrap">{currentFolder.name}</span>
            )}
          </div>
        </div>

        {/* File List Content - Bigger Grid, Bigger Cards */}
        <div className="flex-1 overflow-y-auto px-6 md:px-10 pb-24 custom-scrollbar">
          {loading && (
            <div className="flex flex-col h-full items-center justify-center gap-4 opacity-50">
              <Loader2 className="animate-spin h-12 w-12 text-brand" />
              <span className="text-lg">Carregando {currentFolder.name.toLowerCase()}...</span>
            </div>
          )}

          {!loading && !error && (
             <>
               {filteredFiles.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-80 text-text-sec/50 gap-6">
                     <Folder size={80} strokeWidth={1} />
                     <p className="text-xl">Esta pasta está vazia.</p>
                  </div>
               ) : (
                 <div className={viewMode === 'grid' ? "grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-6 pb-10" : "flex flex-col gap-4 pb-10"}>
                    
                    {/* Back Button (Virtual) */}
                    {breadcrumbs.length > 0 && search === '' && (
                        viewMode === 'grid' ? (
                          <button
                            onClick={() => {
                              const prev = breadcrumbs[breadcrumbs.length - 1];
                              const newCrumbs = breadcrumbs.slice(0, -1);
                              setBreadcrumbs(newCrumbs);
                              setCurrentFolder(prev);
                            }}
                            className="flex flex-col p-8 rounded-[2rem] bg-surface/50 border border-border border-dashed hover:border-text-sec transition-all text-left items-center justify-center min-h-[220px] group"
                          >
                              <div className="h-16 w-16 rounded-full bg-surface flex items-center justify-center text-text-sec mb-4 group-hover:scale-110 transition-transform">
                                <ChevronRight size={32} className="rotate-180"/>
                              </div>
                              <span className="text-lg text-text-sec">Voltar</span>
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                                const prev = breadcrumbs[breadcrumbs.length - 1];
                                setBreadcrumbs(breadcrumbs.slice(0, -1));
                                setCurrentFolder(prev);
                            }}
                            className="flex items-center gap-6 p-6 rounded-3xl bg-surface/30 hover:bg-surface transition-all text-left border border-border border-dashed text-text-sec"
                          >
                              <div className="h-12 w-12 flex items-center justify-center">
                                  <ChevronRight size={24} className="rotate-180"/>
                              </div>
                              <span className="text-lg">Voltar</span>
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
                            className="group flex flex-col p-6 md:p-8 rounded-[2rem] bg-surface hover:brightness-110 transition-all border border-border hover:border-brand/30 text-left relative overflow-hidden shadow-sm hover:shadow-xl min-h-[220px]"
                          >
                            <div className="flex items-center justify-between mb-6 w-full relative z-10">
                              <div className={`h-16 w-16 rounded-2xl flex items-center justify-center shrink-0 ${isFolder ? 'bg-blue-500/10 text-blue-400' : 'bg-brand/10 text-brand'}`}>
                                {isFolder ? <Folder size={32} fill="currentColor" className="opacity-50" /> : <FileText size={32} />}
                              </div>
                              {file.starred && <Star size={24} className="text-yellow-400 fill-yellow-400" />}
                            </div>
                            
                            <div className="min-w-0 z-10 w-full mt-auto">
                              <p className="font-medium truncate text-text group-hover:text-brand transition-colors text-lg md:text-xl leading-tight" title={file.name}>
                                {file.name}
                              </p>
                              <p className="text-base text-text-sec mt-2">
                                {isFolder ? 'Pasta' : 'PDF'}
                              </p>
                            </div>

                            {file.thumbnailLink && !isFolder && (
                              <div className="absolute right-0 bottom-0 w-32 h-32 opacity-10 group-hover:opacity-20 transition-opacity translate-x-6 translate-y-6 rotate-12 pointer-events-none">
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
                            className="group flex items-center gap-6 p-5 rounded-3xl bg-surface hover:brightness-110 transition-all text-left border border-border hover:border-brand/30"
                          >
                            <div className={`h-14 w-14 rounded-2xl flex items-center justify-center shrink-0 ${isFolder ? 'bg-blue-500/10 text-blue-400' : 'bg-brand/10 text-brand'}`}>
                              {isFolder ? <Folder size={28} fill="currentColor" className="opacity-50"/> : <FileText size={28} />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate text-text text-lg">{file.name}</p>
                            </div>
                            <span className="text-base text-text-sec hidden sm:block w-32">
                              {isFolder ? 'Pasta' : 'PDF'}
                            </span>
                            <div className="w-10 h-10 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 bg-bg transition-opacity">
                              <ChevronRight size={20} className="text-text-sec"/>
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