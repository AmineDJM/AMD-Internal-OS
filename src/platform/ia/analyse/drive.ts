import type { UtilisateurOutil } from "@/platform/ia/outil";
import { driveNodeToFile, resolveDriveFile } from "@/platform/ia/drive";
import { lireTableur, type FeuilleLue } from "@/platform/ia/analyse/tableur";

/**
 * UN TABLEUR DU DRIVE, LU SOUS LES DROITS DE LA PERSONNE (lot K1, décision 0031) — par son identifiant (une pièce
 * jointe) ou par son nom. La résolution et le contrôle `canViewDrive` sont ceux du socle (`platform/ia/drive.ts`) :
 * un fichier que la personne ne voit pas n'est pas lu, un nom ambigu rend les candidats, jamais « le premier ».
 */
export type TableurDuDrive =
  | { ok: true; nodeId: string; nom: string; format: "xlsx" | "csv"; feuilles: FeuilleLue[] }
  | { ok: false; erreur: string };

const RE_ID = /^c[a-z0-9]{20,}$/;

export async function lireTableurDuDrive(user: UtilisateurOutil, ref: string, opts: { max?: number } = {}): Promise<TableurDuDrive> {
  const r = (ref ?? "").trim();
  if (!r) return { ok: false, erreur: "aucun fichier désigné" };
  let id = r;
  if (!RE_ID.test(r)) {
    const f = await resolveDriveFile(user, r);
    if ("error" in f) return { ok: false, erreur: f.error };
    id = f.id;
  }
  const fichier = await driveNodeToFile(user, id);
  if (!(fichier instanceof File)) return { ok: false, erreur: fichier.error };
  const lu = await lireTableur(Buffer.from(await fichier.arrayBuffer()), fichier.name, opts);
  return lu.ok ? { ok: true, nodeId: id, nom: fichier.name, format: lu.format, feuilles: lu.feuilles } : lu;
}
