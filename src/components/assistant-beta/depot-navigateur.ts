import { estFichierSysteme, parcourirDepot, type EntreeDepot, type Parcours } from "@/lib/agent/lecture/depot";

/**
 * LE NAVIGATEUR, CÔTÉ DÉPÔT — ce que les règles pures (`lib/agent/lecture/depot.ts`) ne peuvent pas
 * toucher : les `FileSystemEntry` d'un glisser-déposer, le presse-papiers, le téléversement avec sa
 * progression. Aucun import serveur : ce module part dans l'onglet.
 */

type EntreeNavigateur = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, ko: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: EntreeNavigateur[]) => void, ko: (e: unknown) => void) => void };
};

/** Une entrée du navigateur → l'interface des règles. Un dossier se lit lot après lot jusqu'au lot vide. */
function adapter(e: EntreeNavigateur): EntreeDepot {
  return {
    isFile: e.isFile,
    isDirectory: e.isDirectory,
    name: e.name,
    fichier: e.isFile && e.file ? () => new Promise<File>((ok, ko) => e.file!(ok, ko)) : undefined,
    lister: e.isDirectory && e.createReader
      ? async () => {
          const lecteur = e.createReader!();
          const tout: EntreeDepot[] = [];
          for (;;) {
            const lot = await new Promise<EntreeNavigateur[]>((ok, ko) => lecteur.readEntries(ok, ko));
            if (!lot.length) break;
            tout.push(...lot.map(adapter));
          }
          return tout;
        }
      : undefined,
  };
}

/** Le dépôt contient-il des fichiers (et pas un texte ou un lien glissé depuis la page) ? */
export const deposeDesFichiers = (dt: DataTransfer | null): boolean => !!dt && Array.from(dt.types ?? []).includes("Files");

/**
 * CE QUI A ÉTÉ DÉPOSÉ — fichiers et dossiers, parcourus récursivement. Les entrées sont prises
 * PENDANT l'événement (le navigateur vide `items` ensuite) ; sans `webkitGetAsEntry`, les fichiers seuls.
 */
export function lireDepot(dt: DataTransfer): Promise<Parcours<File>> {
  const entrees: EntreeDepot[] = [];
  for (const it of Array.from(dt.items ?? [])) {
    if (it.kind !== "file") continue;
    const e = (it as DataTransferItem & { webkitGetAsEntry?: () => EntreeNavigateur | null }).webkitGetAsEntry?.();
    if (e) entrees.push(adapter(e));
  }
  if (entrees.length) return parcourirDepot<File>(entrees);
  return Promise.resolve(depuisListe(Array.from(dt.files ?? [])));
}

/** Une liste de fichiers (trombone, dossier choisi, presse-papiers) — le chemin relatif s'il existe. */
export function depuisListe(fichiers: File[]): Parcours<File> {
  const out: Parcours<File> = { trouves: [], ignores: 0, tronque: false };
  for (const f of fichiers) {
    const chemin = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (estFichierSysteme(chemin)) out.ignores++;
    else out.trouves.push({ chemin, fichier: f });
  }
  return out;
}

/** Une image collée s'appelle « image.png » : on lui donne un nom daté, pour ne pas la confondre. */
export function nommerCollage(f: File, i: number): File {
  if (f.name && f.name !== "image.png" && f.name !== "image.jpg") return f;
  const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const h = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return new File([f], `capture-${h}${i ? `-${i + 1}` : ""}.${ext}`, { type: f.type, lastModified: f.lastModified });
}

/**
 * TÉLÉVERSE un fichier dans le Drive de la personne (`/api/drive/upload` : droits, quotas, formats,
 * chiffrement) en rapportant la progression ; seul son identifiant revient.
 */
export function televerser(fichier: File, surProgression?: (part: number) => void): Promise<{ id: string } | { erreur: string }> {
  return new Promise((resoudre) => {
    const fd = new FormData();
    fd.set("file", fichier);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/drive/upload");
    xhr.responseType = "text";
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && surProgression) surProgression(e.loaded / e.total); };
    xhr.onload = () => {
      let j: { id?: string; error?: string } = {};
      try { j = JSON.parse(xhr.responseText || "{}") as typeof j; } catch { j = {}; }
      if (xhr.status >= 200 && xhr.status < 300 && j.id) resoudre({ id: j.id });
      else resoudre({ erreur: j.error ?? (xhr.status === 413 ? "Fichier trop volumineux pour le serveur." : "Envoi refusé.") });
    };
    xhr.onerror = () => resoudre({ erreur: "Connexion interrompue." });
    xhr.onabort = () => resoudre({ erreur: "Envoi annulé." });
    xhr.send(fd);
  });
}
