import React, { useEffect, useState } from 'react';
import { DriveFile } from '../types';
import { getRecentFiles } from '../services/storageService';
import { FileText, Clock, ArrowRight, Upload, Menu } from 'lucide-react';

interface DashboardProps {
  userName?: string | null;
  onOpenFile: (file: DriveFile) => void;
  onUploadLocal: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onChangeView: (view: 'browser') => void;
  onToggleMenu: () => void;
}

export const Dashboard: React.FC<DashboardProps> = ({ userName, onOpenFile, onUploadLocal, onChangeView, onToggleMenu }) => {
  const [recents, setRecents] = useState<(DriveFile & { lastOpened: Date })[]>([]);
  const [greeting, setGreeting] = useState('');

  useEffect(() => {
    getRecentFiles().then(setRecents);
    
    const hr = new Date().getHours();
    if (hr < 12) setGreeting('Bom dia');
    else if (hr < 18) setGreeting('Boa tarde');
    else setGreeting('Boa noite');
  }, []);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-bg text-text p-6 md:p-12">
      
      {/* Menu Button (Always Visible now to control sidebar) */}
      <div className="mb-6 md:mb-8">
        <button onClick={onToggleMenu} className="custom-menu-btn p-3 -ml-3 text-text-sec hover:text-text rounded-full hover:bg-surface transition">
          <Menu size={32} />
        </button>
      </div>

      {/* Hero Header */}
      <header className="mb-12 md:mb-16 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <h1 className="text-4xl md:text-6xl font-normal text-text mb-4 tracking-tight leading-tight">
          {greeting}, <br className="lg:hidden" />
          <span className="text-brand font-medium">{userName?.split(' ')[0] || 'Visitante'}</span>
        </h1>
        <p className="text-lg md:text-2xl text-text-sec">Pronto para continuar de onde parou?</p>
      </header>

      {/* Quick Actions - Larger Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
        <button 
          onClick={() => onChangeView('browser')}
          className="p-8 rounded-[2rem] bg-surface hover:brightness-110 transition-all group text-left border border-border hover:border-brand/50 flex flex-col items-start gap-6 shadow-sm hover:shadow-xl"
        >
          <div className="w-16 h-16 rounded-2xl bg-brand/10 text-brand flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
            <FileText size={32} />
          </div>
          <div>
             <h3 className="text-2xl font-medium mb-2 text-text">Navegar no Drive</h3>
             <p className="text-base text-text-sec">Acesse sua biblioteca de PDFs</p>
          </div>
        </button>

        <label className="p-8 rounded-[2rem] bg-surface hover:brightness-110 transition-all group text-left border border-border hover:border-brand/50 cursor-pointer flex flex-col items-start gap-6 shadow-sm hover:shadow-xl">
           <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
            <Upload size={32} />
          </div>
          <div>
             <h3 className="text-2xl font-medium mb-2 text-text">Arquivo Local</h3>
             <p className="text-base text-text-sec">Abra um PDF do seu dispositivo</p>
          </div>
          <input 
              type="file" 
              accept="application/pdf" 
              className="hidden" 
              id="local-upload-dash"
              onChange={onUploadLocal}
            />
        </label>
      </div>

      {/* Recent Files Section */}
      <div className="mb-20">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl md:text-3xl font-normal text-text">Arquivos Recentes</h2>
          {recents.length > 0 && (
            <button onClick={() => onChangeView('browser')} className="text-lg text-brand hover:text-brand/80 flex items-center gap-2 px-4 py-2 hover:bg-brand/5 rounded-full transition">
              Ver todos <ArrowRight size={20} />
            </button>
          )}
        </div>

        {recents.length === 0 ? (
          <div className="h-64 rounded-3xl border-2 border-dashed border-border flex flex-col items-center justify-center text-text-sec text-center p-8">
            <Clock size={48} className="mb-4 opacity-50" />
            <p className="text-lg">Nenhum arquivo aberto recentemente</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {recents.map((file) => (
              <div 
                key={file.id}
                onClick={() => onOpenFile(file)}
                className="group relative bg-surface rounded-[1.5rem] p-5 hover:brightness-110 transition-all cursor-pointer border border-border hover:border-brand/50 flex flex-col gap-4 shadow-sm hover:shadow-xl"
              >
                <div className="w-full aspect-[4/5] bg-bg rounded-xl overflow-hidden relative shadow-inner shrink-0">
                  {file.thumbnailLink ? (
                    <img src={file.thumbnailLink} alt="" className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-bg">
                      <FileText size={64} className="text-text-sec opacity-20" />
                    </div>
                  )}
                  {/* Hover Overlay */}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity items-center justify-center hidden md:flex backdrop-blur-[2px]">
                    <span className="bg-brand text-bg px-6 py-3 rounded-full text-base font-bold shadow-lg transform translate-y-4 group-hover:translate-y-0 transition-transform">Abrir</span>
                  </div>
                </div>
                
                <div className="min-w-0">
                  <h3 className="font-medium text-text truncate mb-2 text-lg" title={file.name}>{file.name}</h3>
                  <div className="flex items-center text-sm text-text-sec gap-2">
                    <Clock size={16} />
                    <span>{new Date(file.lastOpened).toLocaleDateString('pt-BR')}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};