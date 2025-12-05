import React, { useState, useEffect } from 'react';
import { auth } from './firebase';
import { User, onAuthStateChanged } from 'firebase/auth';
import { signInWithGoogleDrive, logout } from './services/authService';
import { syncPendingAnnotations, addRecentFile } from './services/storageService';
import { DriveBrowser } from './components/DriveBrowser';
import { PdfViewer } from './components/PdfViewer';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { DriveFile } from './types';
import { ShieldCheck, LogIn, RefreshCw, AlertCircle, XCircle, Copy, Menu } from 'lucide-react';

// Helpers para Local Storage com Expiração
const TOKEN_KEY = 'drive_access_token';
const EXPIRY_KEY = 'drive_token_expiry';

const getStoredToken = () => {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiry = localStorage.getItem(EXPIRY_KEY);
  
  if (!token || !expiry) return null;
  
  // Se o token já expirou (ou está prestes a expirar nos próximos 5 min), descartamos
  if (Date.now() > parseInt(expiry)) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRY_KEY);
    return null;
  }
  
  return token;
};

const saveToken = (token: string) => {
  localStorage.setItem(TOKEN_KEY, token);
  // Token do Google dura 1h (3600s). Definimos expiração segura de 50 minutos.
  const expiryTime = Date.now() + (50 * 60 * 1000);
  localStorage.setItem(EXPIRY_KEY, expiryTime.toString());
};

const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => getStoredToken());
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState<{title: string, message: string, code?: string} | null>(null);
  
  // --- Navigation & Tab State ---
  // activeTab controls what is currently visible: 'dashboard' | 'browser' | [fileId]
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [openFiles, setOpenFiles] = useState<DriveFile[]>([]);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  
  // Flag for Popup Mode (Legacy/Direct Link)
  const [isPopup, setIsPopup] = useState(false);

  // Determine if we are in "Viewer Mode" (reading a file)
  const isViewerActive = !['dashboard', 'browser'].includes(activeTab);

  // Monitor URL Params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    
    if (mode === 'viewer') {
      const fileId = params.get('fileId');
      const fileName = params.get('fileName');
      const parentsStr = params.get('parents');
      
      if (fileId && fileName) {
        setIsPopup(true);
        const parents = parentsStr ? JSON.parse(decodeURIComponent(parentsStr)) : undefined;
        
        const fileFromUrl: DriveFile = {
          id: fileId,
          name: fileName,
          mimeType: 'application/pdf',
          parents
        };
        
        // In popup mode, we treat the file as the only "open" file
        setOpenFiles([fileFromUrl]);
        setActiveTab(fileId);
      }
    }
  }, []);

  // Monitor Firebase Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setAccessToken(null);
        clearToken();
        if (!isPopup) {
            setOpenFiles([]);
            setActiveTab('dashboard');
        }
      }
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, [isPopup]);

  // Monitor Online Status
  useEffect(() => {
    const handleOnline = () => syncPendingAnnotations();
    window.addEventListener('online', handleOnline);
    if (navigator.onLine) syncPendingAnnotations();
    return () => window.removeEventListener('online', handleOnline);
  }, []);

  const handleLogin = async () => {
    setAuthError(null);
    try {
      const result = await signInWithGoogleDrive();
      setAccessToken(result.accessToken);
      saveToken(result.accessToken);
    } catch (e: any) {
      console.error("Login error full:", e);
      let errorData = {
        title: "Falha no Login",
        message: "Ocorreu um erro inesperado. Tente novamente.",
        code: e.code
      };
      if (e.code === 'auth/unauthorized-domain') {
        errorData = {
          title: "Domínio Não Autorizado",
          message: `O domínio atual (${window.location.hostname}) não está autorizado no Firebase Console.`,
          code: e.code
        };
      } else if (e.message) {
         errorData.message = e.message;
      }
      setAuthError(errorData);
    }
  };

  const handleLogout = async () => {
    setAuthError(null);
    await logout();
    setAccessToken(null);
    clearToken();
    setOpenFiles([]);
    setActiveTab('dashboard');
    setIsMobileMenuOpen(false);
  };

  const handleAuthError = () => {
    setAccessToken(null);
    clearToken();
  };

  // --- Tab Management Logic ---

  const handleOpenFile = (file: DriveFile) => {
    addRecentFile(file);
    
    // Check if file is already open
    if (!openFiles.find(f => f.id === file.id)) {
      setOpenFiles(prev => [...prev, file]);
    }
    
    // Switch to this file's tab
    setActiveTab(file.id);
    setIsMobileMenuOpen(false);
  };

  const handleCloseFile = (fileId: string) => {
    const newFiles = openFiles.filter(f => f.id !== fileId);
    setOpenFiles(newFiles);
    
    // If we closed the active tab, switch to another one
    if (activeTab === fileId) {
      if (newFiles.length > 0) {
        // Switch to the last opened file
        setActiveTab(newFiles[newFiles.length - 1].id);
      } else {
        // Fallback to dashboard if no files left
        setActiveTab('dashboard');
      }
    }
  };

  const handleLocalUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const newFile: DriveFile = {
        id: `local-${Date.now()}`,
        name: file.name,
        mimeType: file.type,
        blob: file
      };
      
      handleOpenFile(newFile);
    }
  };

  const handleTabSwitch = (tabId: string) => {
    setActiveTab(tabId);
    setIsMobileMenuOpen(false);
  };

  if (loadingAuth) {
    return <div className="h-screen w-full flex items-center justify-center bg-bg text-text">Carregando...</div>;
  }

  // If Popup Mode (legacy), simplified render
  if (isPopup) {
    const activeFile = openFiles.find(f => f.id === activeTab);
    
    if (!user) {
       return (
          <div className="flex h-screen flex-col items-center justify-center p-6 text-center bg-bg text-text">
               <ShieldCheck size={48} className="text-text-sec mb-4" />
               <h2 className="text-2xl font-bold mb-2">Autenticação Necessária</h2>
               <button onClick={handleLogin} className="flex items-center gap-2 py-3 px-6 bg-brand text-bg rounded-full font-medium">
                 <LogIn size={18} /> Entrar com Google
              </button>
          </div>
       );
    }
    if (!activeFile) return <div className="p-10 text-text">Arquivo não encontrado.</div>;

    return (
      <PdfViewer 
        accessToken={accessToken}
        fileId={activeFile.id}
        fileName={activeFile.name}
        fileParents={activeFile.parents}
        uid={user.uid}
        onBack={() => window.close()}
        fileBlob={activeFile.blob}
        isPopup={true}
      />
    );
  }

  // Main App Layout (Sidebar + Tabbed Content)
  return (
    <>
      <div className="flex h-screen w-full bg-bg overflow-hidden transition-colors duration-300">
        <Sidebar 
          activeTab={activeTab}
          onSwitchTab={handleTabSwitch}
          openFiles={openFiles}
          onCloseFile={handleCloseFile}
          user={user}
          onLogout={handleLogout}
          isOpen={isMobileMenuOpen}
          onClose={() => setIsMobileMenuOpen(false)}
          docked={!isViewerActive} // Only dock sidebar on Desktop when NOT reading a PDF
        />
        
        {/* Main Content Area - Stacked Views for Keep-Alive */}
        <main className="flex-1 relative overflow-hidden flex flex-col bg-bg">
          
          {/* Guest Wall for Browser Tab */}
          {!user && activeTab === 'browser' && (
             <div className="absolute inset-0 z-20 bg-bg p-6 flex flex-col animate-in fade-in">
                <div className="md:hidden mb-6">
                   <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2 text-text-sec hover:text-text">
                     <Menu size={24} />
                   </button>
                 </div>
                 <div className="flex-1 flex flex-col items-center justify-center text-center">
                    <ShieldCheck size={48} className="text-text-sec mb-4" />
                    <h2 className="text-2xl font-bold mb-2 text-text">Login Necessário</h2>
                    <p className="text-text-sec mb-6">Acesse seus arquivos do Drive com segurança.</p>
                    <button onClick={handleLogin} className="btn-primary flex items-center gap-2 py-3 px-6 bg-brand text-bg rounded-full font-medium">
                      <LogIn size={18} /> Entrar com Google
                    </button>
                 </div>
             </div>
          )}

           {/* Token Expired Wall */}
           {user && activeTab === 'browser' && !accessToken && (
             <div className="absolute inset-0 z-20 bg-bg p-6 flex flex-col animate-in fade-in">
                 <div className="md:hidden mb-6">
                   <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2 text-text-sec hover:text-text">
                     <Menu size={24} />
                   </button>
                 </div>
                 <div className="flex-1 flex flex-col items-center justify-center text-center">
                    <AlertCircle size={48} className="text-yellow-500 mb-4" />
                    <h2 className="text-2xl font-bold mb-2 text-text">Conexão Expirada</h2>
                    <button onClick={handleLogin} className="btn-primary flex items-center gap-2 py-3 px-6 bg-brand text-bg rounded-full font-medium">
                      <RefreshCw size={18} /> Reconectar Drive
                    </button>
                 </div>
             </div>
           )}

          {/* DASHBOARD VIEW */}
          <div className="w-full h-full" style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }}>
            <Dashboard 
              userName={user?.displayName}
              onOpenFile={handleOpenFile}
              onUploadLocal={handleLocalUpload}
              onChangeView={(v) => handleTabSwitch(v)}
              onToggleMenu={() => setIsMobileMenuOpen(true)}
            />
          </div>

          {/* BROWSER VIEW */}
          <div className="w-full h-full" style={{ display: activeTab === 'browser' ? 'block' : 'none' }}>
             {user && accessToken && (
                <DriveBrowser 
                  accessToken={accessToken}
                  onSelectFile={handleOpenFile}
                  onLogout={handleLogout}
                  onAuthError={handleAuthError}
                  onToggleMenu={() => setIsMobileMenuOpen(true)}
                />
             )}
          </div>

          {/* OPEN FILES VIEWS (Keep-Alive) */}
          {openFiles.map(file => (
            <div 
              key={file.id} 
              className="w-full h-full absolute inset-0 bg-bg"
              style={{ display: activeTab === file.id ? 'block' : 'none' }}
            >
              <PdfViewer 
                 accessToken={accessToken}
                 fileId={file.id}
                 fileName={file.name}
                 fileParents={file.parents}
                 uid={user ? user.uid : 'guest'}
                 onBack={() => handleCloseFile(file.id)} // "Back" closes the tab in this context
                 fileBlob={file.blob}
                 isPopup={false}
                 onToggleNavigation={() => setIsMobileMenuOpen(true)}
              />
            </div>
          ))}

        </main>
      </div>
      
      {/* Error Toast */}
      {authError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-md p-4 animate-in slide-in-from-top-4">
          <div className="bg-surface border border-red-500/50 rounded-xl shadow-2xl p-4 flex gap-4 text-text relative">
            <div className="bg-red-500/10 p-2 rounded-full h-fit text-red-500"><AlertCircle size={24} /></div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-red-500 mb-1">{authError.title}</h3>
              <p className="text-sm text-text-sec mb-2 break-words">{authError.message}</p>
              {authError.code === 'auth/unauthorized-domain' && (
                <div className="bg-bg p-2 rounded border border-border flex items-center justify-between gap-2 mt-2">
                  <code className="text-xs text-brand truncate flex-1">{window.location.hostname}</code>
                  <button onClick={() => navigator.clipboard.writeText(window.location.hostname)} className="p-1 hover:bg-white/10 rounded text-text-sec hover:text-text"><Copy size={14} /></button>
                </div>
              )}
            </div>
            <button onClick={() => setAuthError(null)} className="absolute top-2 right-2 text-text-sec hover:text-text p-1"><XCircle size={18} /></button>
          </div>
        </div>
      )}

      {/* Persistent Hidden Input */}
      <input type="file" id="local-upload-hidden" accept="application/pdf" onChange={handleLocalUpload} className="hidden" />
    </>
  );
}