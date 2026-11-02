/**
 * LES PORTS EN MÉMOIRE — ce qui rend le moteur exerçable sans base ni Drive.
 *
 * Ils implémentent le MÊME contrat que le composeur de production (`in-process/artifact/`) : un
 * test qui passe ici passe donc pour la même raison en production, à ceci près que les octets
 * viennent d'une `Map` au lieu d'un blob chiffré.
 *
 * `droitEcriture` existe pour une raison précise : §74 exige qu'une personne sans droit d'écrire
 * puisse LIRE et travailler en session, mais pas enregistrer. Sans ce commutateur, la propriété
 * ne serait vérifiée nulle part.
 *
 * Ce module n'est pas un `.test.ts` : il est partagé par plusieurs suites et par le banc.
 */

import type { ArtifactFormat } from "@/lib/artifact/object-model/model";
import { formatDeFichier } from "@/lib/artifact/adapters/registry";
import type { PortsArtefact } from "@/lib/artifact/ports";
import type { MagasinSessions, OperationPersistee, SessionPersistee } from "@/lib/artifact/runtime/engine";

export interface VersionFausse { version: number; octets: Buffer; note: string }

export interface DriveFaux {
  fichiers: Map<string, { nom: string; versions: VersionFausse[] }>;
  audit: { userId: string; action: string; cible: string; detail: string }[];
  droitEcriture: boolean;
  /**
   * CE QUE LA VISION « VOIT » — indexé par la TAILLE des octets qu'on lui donne.
   *
   * La taille, et pas le nom : c'est le seul lien qui prouve que les octets sortis du document
   * sont bien ceux qui arrivent au port. Indexer par nom laisserait passer un adaptateur qui
   * rend l'image 1 quand on demande la 3 — les deux s'appellent `image1.png` dans leur zip
   * respectif, et le test resterait vert sur le défaut qu'il existe pour attraper.
   */
  vision?: Map<number, { texte: string; note: string | null }>;
  /** Les lectures demandées, dans l'ordre — pour vérifier qu'on n'appelle pas le modèle pour rien. */
  lectures?: { nom: string; taille: number }[];
}

export function portsMemoire(drive: DriveFaux): PortsArtefact {
  const fiche = (nodeId: string) => {
    const f = drive.fichiers.get(nodeId);
    if (!f) return null;
    const derniere = f.versions[f.versions.length - 1];
    return {
      nodeId, nom: f.nom, mime: null, taille: derniere.octets.length,
      version: derniere.version, format: formatDeFichier(f.nom, null) as ArtifactFormat | null,
    };
  };

  return {
    documents: {
      async decrire(_userId, nodeId) { return fiche(nodeId); },
      async lire(_userId, nodeId, version) {
        return drive.fichiers.get(nodeId)?.versions.find((v) => v.version === version)?.octets ?? null;
      },
      async ecrireVersion(_userId, nodeId, octets, opts) {
        if (!drive.droitEcriture) throw new Error("vous n'avez pas le droit de modifier ce document");
        const f = drive.fichiers.get(nodeId);
        if (!f) throw new Error("document introuvable");
        const version = f.versions[f.versions.length - 1].version + 1;
        f.versions.push({ version, octets, note: opts.resume });
        return { version, taille: octets.length };
      },
      async creerFichier(_userId, opts) {
        if (!drive.droitEcriture) throw new Error("vous n'avez pas le droit de créer un document");
        const nodeId = `nouveau-${drive.fichiers.size + 1}`;
        drive.fichiers.set(nodeId, { nom: opts.nom, versions: [{ version: 1, octets: opts.octets, note: "création" }] });
        return { nodeId, version: 1 };
      },
      async chercher(_userId, requete, limite) {
        const mots = requete.toLowerCase().split(/\s+/).filter(Boolean);
        const out = [];
        for (const [nodeId, f] of drive.fichiers) {
          const nom = f.nom.toLowerCase();
          if (!mots.every((m) => nom.includes(m))) continue;
          const x = fiche(nodeId);
          if (x) out.push(x);
          if (out.length >= limite) break;
        }
        return out;
      },
    },
    audit: {
      async tracer(opts) { drive.audit.push(opts); },
    },
    vision: {
      async lire(_userId, octets, nom) {
        drive.lectures?.push({ nom, taille: octets.length });
        const vu = drive.vision?.get(octets.length);
        return vu ?? { texte: "", note: "aucun texte lisible (image d'essai sans contenu)" };
      },
    },
  };
}

/** Le magasin de sessions, en mémoire. Même contrat, même idempotence par clé. */
export function magasinMemoire(): MagasinSessions {
  const sessions = new Map<string, SessionPersistee>();
  const ops = new Map<string, OperationPersistee[]>();
  let n = 0;

  return {
    async creer(s) {
      n += 1;
      const session: SessionPersistee = {
        ...s, id: `s${n}`, state: "OPENING", revision: 0, dirty: false, savedVersion: null,
      };
      sessions.set(session.id, session);
      ops.set(session.id, []);
      return { ...session };
    },
    async lire(sessionId, userId) {
      const s = sessions.get(sessionId);
      return s && s.userId === userId ? { ...s } : null;
    },
    async ouverte(userId, nodeId) {
      for (const s of sessions.values()) {
        if (s.userId === userId && s.nodeId === nodeId && s.state !== "CLOSED") return { ...s };
      }
      return null;
    },
    async derniere(userId) {
      const vivantes = [...sessions.values()].filter((s) => s.userId === userId && s.state !== "CLOSED");
      const derniere = vivantes[vivantes.length - 1];
      return derniere ? { ...derniere } : null;
    },
    async majSession(sessionId, champs) {
      const s = sessions.get(sessionId);
      if (!s) return;
      const { lastError, ...reste } = champs;
      void lastError;
      Object.assign(s, reste);
    },
    async operations(sessionId) {
      return (ops.get(sessionId) ?? []).map((o) => ({ ...o }));
    },
    async ajouterOperation(sessionId, op) {
      const liste = ops.get(sessionId) ?? [];
      if (liste.some((o) => o.operationId === op.operationId)) return false;
      liste.push({ ...op });
      ops.set(sessionId, liste);
      return true;
    },
    async marquerAnnulee(sessionId, seq, annulee) {
      const cible = (ops.get(sessionId) ?? []).find((o) => o.seq === seq);
      if (cible) cible.undone = annulee;
    },
    async marquerRevue(sessionId, seq, revue) {
      const cible = (ops.get(sessionId) ?? []).find((o) => o.seq === seq);
      if (cible) cible.revue = revue;
    },
    async fermer(sessionId) {
      const s = sessions.get(sessionId);
      if (s) s.state = "CLOSED";
    },
  };
}
