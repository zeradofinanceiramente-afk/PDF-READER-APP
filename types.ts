import { User } from "firebase/auth";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  thumbnailLink?: string;
  parents?: string[]; // Pasta onde o arquivo está
  blob?: Blob; // Optional: for local files or pre-loaded content
}

export interface Annotation {
  id?: string;
  page: number;
  bbox: [number, number, number, number]; // x, y, width, height relative to canvas at specific scale
  text?: string;
  type: 'highlight' | 'note' | 'ink';
  points?: number[][]; // Array de coordenadas [x, y] para desenhos
  author?: string;
  createdAt?: any;
  updatedAt?: any;
  color?: string;
  opacity?: number;
  strokeWidth?: number;
}

export interface AppState {
  user: User | null;
  accessToken: string | null;
  currentFile: DriveFile | null;
  view: 'login' | 'browser' | 'viewer';
}

export interface ThemeColors {
  brand: string;
  bg: string;
  surface: string;
  text: string;
}