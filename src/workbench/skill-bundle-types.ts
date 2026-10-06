export interface SkillFile {
    path: string;
    mode: '100644' | '100755';
    encoding: 'base64';
    data: string;
    bytes: number;
    sha256: string;
    sourceBlobSha: string;
}
export interface SkillBundle {
    version: 1;
    root: string;
    commit: string;
    files: SkillFile[];
    bytes: number;
    sha256: string;
}
export interface SkillTreeEntry { path: string; type: string; mode?: string; sha: string; size?: number }
