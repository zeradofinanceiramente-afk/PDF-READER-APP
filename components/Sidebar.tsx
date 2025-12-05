import React, { useState } from 'react';
import { Home, FolderOpen, LogOut, User as UserIcon, X, Palette, ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { User } from 'firebase/auth';
import { ThemeSwitcher } from './ThemeSwitcher';
import { DriveFile } from '../types';

interface SidebarProps {
  activeTab: string;
  onSwitchTab: (tabId: string) => void;
  openFiles: DriveFile[];
  onCloseFile: (fileId: string) => void;
  user: User | null;
  onLogout: () => void;
  isOpen: boolean;
  onClose: () => void;
  docked?: boolean;
}

export const Sidebar: React.FC<SidebarProps> = ({ 
  activeTab, 
  onSwitchTab, 
  openFiles, 
  onCloseFile, 
  user, 
  onLogout, 
  isOpen, 
  onClose,
  docked = true
}) => {
  const [isThemesOpen, setIsThemesOpen] = useState(false);

  // Dynamic classes based on docked state
  // If docked (true): behaves as relative sidebar on desktop
  // If not docked (false): behaves as drawer (fixed/absolute) on desktop
  const dockedClasses = docked 
    ? "md:relative md:translate-x-0 md:w-64 md:shadow-none" 
    : "";

  const backdropClasses = docked
    ? "md:hidden"
    : "";

  return (
    <>
      {/* Mobile/Overlay Backdrop */}
      {isOpen && (
        <div 
          className={`fixed inset-0 bg-black/60 backdrop-blur-sm z-40 animate-in fade-in duration-200 ${backdropClasses}`}
          onClick={onClose}
        />
      )}

      {/* Sidebar Container */}
      <div className={`
        fixed inset-y-0 left-0 z-50 w-72 bg-sidebar border-r border-border transition-transform duration-300 shadow-2xl flex flex-col
        ${dockedClasses}
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* App Logo Area */}
        <div className="h-16 flex items-center justify-between px-6 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-brand rounded-xl flex items-center justify-center shadow-lg shadow-brand/20 shrink-0">
              <FolderOpen className="text-bg font-bold" size={20} />
            </div>
            <span className="font-bold text-xl text-text tracking-tight sidebar-text">Annotator</span>
          </div>
          <button onClick={onClose} className={`p-1 text-text-sec hover:text-text ${docked ? 'md:hidden' : ''}`}>
            <X size={24} />
          </button>
        </div>

        {/* Navigation Scroll Area */}
        <nav className="flex-1 py-6 px-4 space-y-6 overflow-y-auto custom-scrollbar">
          
          {/* Main Actions */}
          <div className="space-y-2">
            <button
              onClick={() => { onSwitchTab('dashboard'); onClose(); }}
              className={`w-full flex items-center gap-4 px-4 py-3 rounded-2xl transition-all duration-200 group sidebar-text ${
                activeTab === 'dashboard' 
                  ? 'bg-brand/10 text-brand font-medium' 
                  : 'text-text-sec hover:bg-white/5 hover:text-text'
              }`}
            >
              <Home size={22} className={activeTab === 'dashboard' ? "fill-brand/20" : ""} />
              <span className="text-base">Início</span>
            </button>

            <button
              onClick={() => { onSwitchTab('browser'); onClose(); }}
              className={`w-full flex items-center gap-4 px-4 py-3 rounded-2xl transition-all duration-200 group sidebar-text ${
                activeTab === 'browser' 
                  ? 'bg-brand/10 text-brand font-medium' 
                  : 'text-text-sec hover:bg-white/5 hover:text-text'
              }`}
            >
              <FolderOpen size={22} className={activeTab === 'browser' ? "fill-brand/20" : ""} />
              <span className="text-base">Meus Arquivos</span>
            </button>
          </div>

          {/* Open Files Section */}
          {openFiles.length > 0 && (
            <div className="animate-in fade-in slide-in-from-left-2">
              <div className="px-4 mb-2 text-xs font-bold text-text-sec uppercase tracking-wider">
                Arquivos Abertos
              </div>
              <div className="space-y-1">
                {openFiles.map(file => (
                  <div 
                    key={file.id}
                    className={`group relative flex items-center gap-3 px-4 py-2 rounded-xl transition-all cursor-pointer ${
                      activeTab === file.id 
                        ? 'bg-surface text-text font-medium border border-border shadow-sm' 
                        : 'text-text-sec hover:bg-white/5 hover:text-text border border-transparent'
                    }`}
                    onClick={() => { onSwitchTab(file.id); onClose(); }}
                  >
                    <FileText size={16} className={activeTab === file.id ? 'text-brand' : 'opacity-70'} />
                    <span className="truncate text-sm flex-1 pr-6">{file.name}</span>
                    
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onCloseFile(file.id);
                      }}
                      className="absolute right-2 p-1 text-text-sec hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all rounded-full hover:bg-red-500/10"
                      title="Fechar guia"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Theme Accordion */}
          <div className="pt-4 border-t border-border">
            <button 
              onClick={() => setIsThemesOpen(!isThemesOpen)}
              className="w-full flex items-center justify-between px-4 py-3 text-text-sec hover:text-text rounded-2xl hover:bg-white/5 transition-colors sidebar-text"
            >
              <div className="flex items-center gap-4">
                <Palette size={22} />
                <span className="text-base">Temas</span>
              </div>
              {isThemesOpen ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
            </button>
            
            {isThemesOpen && (
              <div className="pl-12 pr-2 py-2 animate-in slide-in-from-top-2">
                 <ThemeSwitcher />
              </div>
            )}
          </div>
        </nav>

        {/* User Profile Footer */}
        <div className="p-4 border-t border-border mt-auto shrink-0">
          {user ? (
            <div className="flex flex-col gap-3 bg-surface/50 rounded-xl p-3">
              <div className="flex items-center gap-3 overflow-hidden">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="User" className="w-10 h-10 rounded-full border border-border" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-surface flex items-center justify-center border border-border">
                    <UserIcon size={18} className="text-text-sec" />
                  </div>
                )}
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium text-text truncate sidebar-text">{user.displayName}</span>
                  <span className="text-xs text-text-sec truncate sidebar-text">{user.email}</span>
                </div>
              </div>
              <button 
                onClick={onLogout}
                className="w-full flex items-center justify-center gap-2 text-red-400 hover:text-red-300 hover:bg-red-500/10 text-sm py-2 rounded-lg transition-all sidebar-text"
              >
                <LogOut size={16} />
                <span>Sair</span>
              </button>
            </div>
          ) : (
            <div className="text-center text-xs text-text-sec p-2 sidebar-text">Modo Visitante</div>
          )}
        </div>
      </div>
    </>
  );
};