export type Role = 'owner' | 'editor' | 'viewer';
export type LibraryVisibility = 'private' | 'internal' | 'public';
export type PageStatus = 'draft' | 'active' | 'stale' | 'archived';

export interface Person {
  id: string;
  email: string;
  name: string;
  title: string;
  avatarColor: string;
  isAdmin: boolean;
  wecomUserid?: string | null;
}

export interface Actor {
  person: Person;
  teamIds: string[];
  viaApiKey?: boolean;
  apiScope?: 'read' | 'write' | 'admin';
}

export interface LibraryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  kind: string;
  visibility: LibraryVisibility;
  owner_team_id: string | null;
  created_by: string | null;
  settings: string;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: string;
  library_id: string;
  node_id: string | null;
  class_key: string;
  slug: string;
  title: string;
  summary: string;
  tldr: string;
  body: string;
  status: string;
  visibility: string;
  review_assignee: string | null;
  review_status: string;
  review_note: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  confidence: number;
  tags: string;
  aliases: string;
  read_when: string;
  owner_person_id: string | null;
  superseded_by: string | null;
  metadata: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  library_id: string;
  node_id: string | null;
  title: string;
  filename: string;
  ext: string;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  storage_path: string;
  status: string;
  visibility: string;
  language: string;
  page_count: number;
  word_count: number;
  excerpt: string;
  extracted_text: string;
  metadata: string;
  uploaded_by: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExtractedSection {
  level: number;
  title: string;
  text: string;
  page?: number;
}

export interface ExtractedAsset {
  filename: string;
  mime: string;
  kind: 'image' | 'attachment';
  data: Buffer;
  width?: number;
  height?: number;
  ocrText?: string;
}

export interface ExtractResult {
  kind: string;
  text: string;
  sections: ExtractedSection[];
  assets: ExtractedAsset[];
  metadata: Record<string, unknown>;
  pageCount: number;
  warnings: string[];
}
