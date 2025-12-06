import React, { useState, useEffect } from 'react';
import { auth } from './firebase';
import { User, onAuthStateChanged } from 'firebase/auth';
import { signInWithGoogleDrive, logout } from './services/authService';
import { addRecentFile } from './services/storageService';
import { DriveBrowser } from './components/DriveBrowser';
import { PdfViewer } from './components/PdfViewer';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DriveFile } from './types';
import { ShieldCheck, LogIn, RefreshCw, AlertCircle, XCircle, Copy, Menu, Lock } from 'lucide-react';

// Helpers para Local Storage (Token do Drive)
const TOKEN_KEY = 'drive_access_token';

// Alteração: Não verificamos mais a validade temporal estrita aqui.
// Deixamos a API retornar 401 se estiver expirado, para tratarmos graciosamente.
const getStoredToken = () => {
  return localStorage.getItem(TOKEN_KEY);
};

const saveToken = (token: string) => {
  localStorage.setItem(TOKEN_KEY, token);
};

const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY);
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(() => getStoredToken());
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [authError, setAuthError] = useState<{title: string, message: string, code?: string} | null>(null);
  
  // Novo estado: Controla se a sessão do Drive expirou (sem deslogar o usuário do Firebase)
  const [sessionExpired, setSessionExpired] = useState(false);
  
  // --- Navigation & Tab State ---
  // activeTab controls what is currently visible: 'dashboard' | 'browser' | [fileId]
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [openFiles, setOpenFiles] = useState<DriveFile[]>([]);
  
  // Sidebar State (Unified for Mobile & Desktop)
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.innerWidth > 768);
  
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

  // Monitor Online Status (Sync logic removed as requested)
  /* 
  useEffect(() => {
    const handleOnline = () => syncPendingAnnotations();
    window.addEventListener('online', handleOnline);
    if (navigator.onLine) syncPendingAnnotations();
    return () => window.removeEventListener('online', handleOnline);
  }, []);
  */

  const handleLogin = async () => {
    setAuthError(null);
    try {
      const result = await signInWithGoogleDrive();
      setAccessToken(result.accessToken);
      saveToken(result.accessToken);
      setSessionExpired(false); // Limpa estado de expiração se houver
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

  const handleRefreshSession = async () => {
    // Mesma lógica de login, mas focado em renovar o token
    await handleLogin();
  };

  const handleLogout = async () => {
    setAuthError(null);
    setSessionExpired(false);
    await logout();
    setAccessToken(null);
    clearToken();
    setOpenFiles([]);
    setActiveTab('dashboard');
    setIsSidebarOpen(false);
  };

  const handleAuthError = () => {
    // Em vez de limpar o token e causar logout, marcamos como expirado.
    // Isso permite mostrar uma UI de "Renovar" sem perder o contexto do usuário.
    setSessionExpired(true);
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
    // On mobile, close sidebar. On desktop, keep it as is.
    if (window.innerWidth < 768) setIsSidebarOpen(false);
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
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  // Callback to recover from ErrorBoundary
  const handleRecover = () => {
    setActiveTab('dashboard');
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
      <ErrorBoundary>
        <PdfViewer 
          accessToken={accessToken}
          fileId={activeFile.id}
          fileName={activeFile.name}
          fileParents={activeFile.parents}
          uid={user.uid}
          onBack={() => window.close()}
          fileBlob={activeFile.blob}
          isPopup={true}
          onAuthError={handleAuthError} // Pass error handler
        />
      </ErrorBoundary>
    );
  }

  // Main App Layout (Sidebar + Tabbed Content)
  return (
    <>
      <div className="flex h-screen w-full bg-bg overflow-hidden transition-colors duration-300 relative">
        <Sidebar 
          activeTab={activeTab}
          onSwitchTab={handleTabSwitch}
          openFiles={openFiles}
          onCloseFile={handleCloseFile}
          user={user}
          onLogout={handleLogout}
          isOpen={isSidebarOpen}
          onClose={() => setIsSidebarOpen(false)}
          // Sidebar docked only if Viewer is NOT active AND sidebar is set to open (Desktop)
          docked={!isViewerActive && isSidebarOpen} 
        />
        
        {/* Main Content Area - Stacked Views for Keep-Alive */}
        <main className="flex-1 relative overflow-hidden flex flex-col bg-bg">
          
          {/* Guest Wall for Browser Tab */}
          {!user && activeTab === 'browser' && (
             <div className="absolute inset-0 z-20 bg-bg p-6 flex flex-col animate-in fade-in">
                <div className="mb-6">
                   <button onClick={() => setIsSidebarOpen(true)} className="p-3 -ml-3 text-text-sec hover:text-text">
                     <Menu size={32} />
                   </button>
                 </div>
                 <div className="flex-1 flex flex-col items-center justify-center text-center">
                    <ShieldCheck size={64} className="text-text-sec mb-6" />
                    <h2 className="text-4xl font-bold mb-4 text-text">Login Necessário</h2>
                    <p className="text-xl text-text-sec mb-8">Acesse seus arquivos do Drive com segurança.</p>
                    <button onClick={handleLogin} className="btn-primary flex items-center gap-3 py-4 px-8 bg-brand text-bg rounded-full text-lg font-bold">
                      <LogIn size={24} /> Entrar com Google
                    </button>
                 </div>
             </div>
          )}

           {/* OVERLAY DE RENOVAÇÃO DE SESSÃO */}
           {user && sessionExpired && (
             <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6 animate-in fade-in duration-300">
                 <div className="bg-surface border border-border rounded-3xl p-8 max-w-md w-full text-center shadow-2xl">
                    <div className="w-16 h-16 bg-yellow-500/10 text-yellow-500 rounded-full flex items-center justify-center mx-auto mb-6">
                       <Lock size={32} />
                    </div>
                    <h2 className="text-2xl font-bold mb-3 text-text">Sessão Pausada</h2>
                    <p className="text-text-sec mb-8 leading-relaxed">
                       Por segurança, o Google requer que você renove o acesso aos arquivos a cada hora. Clique abaixo para continuar de onde parou.
                    </p>
                    <button 
                      onClick={handleRefreshSession} 
                      className="w-full flex items-center justify-center gap-3 py-4 bg-brand text-bg rounded-xl text-lg font-bold hover:brightness-110 transition-all"
                    >
                      <RefreshCw size={20} /> Renovar Sessão
                    </button>
                 </div>
             </div>
           )}

          {/* DASHBOARD VIEW */}
          <div className="w-full h-full" style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }}>
            <ErrorBoundary onReset={handleRecover}>
              <Dashboard 
                userName={user?.displayName}
                onOpenFile={handleOpenFile}
                onUploadLocal={handleLocalUpload}
                onChangeView={(v) => handleTabSwitch(v)}
                onToggleMenu={() => setIsSidebarOpen(prev => !prev)}
              />
            </ErrorBoundary>
          </div>

          {/* BROWSER VIEW */}
          <div className="w-full h-full" style={{ display: activeTab === 'browser' ? 'block' : 'none' }}>
             {user && accessToken && (
                <ErrorBoundary onReset={handleRecover}>
                  <DriveBrowser 
                    accessToken={accessToken}
                    onSelectFile={handleOpenFile}
                    onLogout={handleLogout}
                    onAuthError={handleAuthError} // Changed: Triggers sessionExpired instead of logout
                    onToggleMenu={() => setIsSidebarOpen(prev => !prev)}
                  />
                </ErrorBoundary>
             )}
          </div>

          {/* OPEN FILES VIEWS (Keep-Alive) */}
          {openFiles.map(file => (
            <div 
              key={file.id} 
              className="w-full h-full absolute inset-0 bg-bg"
              style={{ display: activeTab === file.id ? 'block' : 'none' }}
            >
              <ErrorBoundary onReset={() => handleCloseFile(file.id)}>
                <PdfViewer 
                   accessToken={accessToken}
                   fileId={file.id}
                   fileName={file.name}
                   fileParents={file.parents}
                   uid={user ? user.uid : 'guest'}
                   onBack={() => handleCloseFile(file.id)} // "Back" closes the tab in this context
                   fileBlob={file.blob}
                   isPopup={false}
                   onToggleNavigation={() => setIsSidebarOpen(prev => !prev)}
                   onAuthError={handleAuthError} // Changed: Pass error handler to viewer
                />
              </ErrorBoundary>
            </div>
          ))}

        </main>
      </div>
      
      {/* Error Toast (Non-session errors) */}
      {authError && !sessionExpired && (
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