// Interfaz común de las fuentes de archivos (Google Drive, OneDrive/SharePoint)
// para que el importador recorra y descargue igual en ambas. Solo lectura.

export type ProveedorArchivos = "google" | "microsoft";

export const NOMBRE_PROVEEDOR: Record<ProveedorArchivos, string> = {
  google: "Google Drive",
  microsoft: "OneDrive / SharePoint",
};

export type FileNode = {
  id: string;
  name: string;
  isFolder: boolean;
  mimeType: string | null;
  size: number | null;
  modifiedAt: string | null;
  /** Carpeta que lo contiene (necesario para listar varias carpetas en una sola llamada). */
  parentId: string | null;
};

export interface FileProvider {
  /** Hijos directos de una carpeta. */
  listChildren(folderId: string): Promise<FileNode[]>;
  /** Hijos de varias carpetas, agrupando llamadas (el Worker limita las llamadas externas). */
  listChildrenMany(folderIds: string[]): Promise<FileNode[]>;
  download(file: FileNode): Promise<Uint8Array>;
}
