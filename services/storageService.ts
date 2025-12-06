import { openDB } from "idb";
import { Annotation, DriveFile } from "../types";

// --- IndexedDB Setup ---
const dbPromise = openDB("pwa-drive-annotator", 3, {
  upgrade(db, oldVersion, newVersion, transaction) {
    // Store para anotações locais
    if (!db.objectStoreNames.contains("annotations")) {
      const store = db.createObjectStore("annotations", { keyPath: "id" });
      store.createIndex("fileId", "fileId", { unique: false });
    }
    
    // Remover store antiga se existir (limpeza)
    if (db.objectStoreNames.contains("pendingAnnotations")) {
      db.deleteObjectStore("pendingAnnotations");
    }

    // Store para Histórico de Arquivos Recentes
    if (!db.objectStoreNames.contains("recentFiles")) {
      const store = db.createObjectStore("recentFiles", { keyPath: "id" });
      store.createIndex("lastOpened", "lastOpened");
    }
  }
});

// --- Recent Files Logic ---

export async function addRecentFile(file: DriveFile) {
  const idb = await dbPromise;
  await idb.put("recentFiles", {
    ...file,
    lastOpened: new Date()
  });
}

export async function getRecentFiles(): Promise<(DriveFile & { lastOpened: Date })[]> {
  const idb = await dbPromise;
  const files = await idb.getAll("recentFiles");
  return files.sort((a, b) => b.lastOpened - a.lastOpened);
}

// --- Annotation Logic (Local Only) ---

export async function saveAnnotation(uid: string, fileId: string, ann: Annotation) {
  // O UID é mantido na assinatura para compatibilidade, mas ignorado na lógica local.
  // As anotações vivem no dispositivo.
  const idb = await dbPromise;
  
  // Garante que a anotação tenha um ID final
  const finalId = ann.id || `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  const annotationToSave = {
    ...ann,
    id: finalId,
    fileId: fileId,
    updatedAt: new Date().toISOString()
  };

  await idb.put("annotations", annotationToSave);
  return annotationToSave;
}

export async function loadAnnotations(uid: string, fileId: string): Promise<Annotation[]> {
  const idb = await dbPromise;
  // Busca todas as anotações deste arquivo específico no banco local
  const allAnns = await idb.getAllFromIndex("annotations", "fileId", fileId);
  return allAnns;
}

export async function deleteAnnotation(id: string) {
  const idb = await dbPromise;
  await idb.delete("annotations", id);
}

// Função de sincronização removida pois não usamos mais Firestore.
// Mantemos uma função vazia ou removemos a chamada no App.tsx.
export async function syncPendingAnnotations() {
  // No-op (Operação removida)
  return;
}