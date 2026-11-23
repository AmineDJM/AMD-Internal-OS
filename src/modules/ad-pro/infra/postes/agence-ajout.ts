import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/lib/rbac";
import type { ActionResult } from "@/lib/actions/types";
import type { AdProParent } from "../../domaine/postes";
import { demanderProspection } from "../../actions-postes-agence";
import { assistantesDeDirection } from "../pieces-poste";
import { peutTrancherSur } from "./commun";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE POSTE « PAR UNE AGENCE » EN UN GESTE (Direction, 23/11/2026).
 *
 * « Ajouter » créait un brouillon ; il fallait ensuite le soumettre, puis « Demander la prospection » avec le cahier des
 * charges. Le cahier des charges se saisit maintenant AVEC le poste, et le même clic le soumet et lance la prospection.
 *
 * ── RIEN N'EST RÉÉCRIT : LES DEUX ACTIONS DE L'ÉCRAN, DANS L'ORDRE ─────────────────────────
 *
 *   • la Direction Marketing (ou qui la supplée) : `demanderProspection` — ses gardes (prévalidation, statut, assistante
 *     active), son écriture (le poste passe « en attente » avec elle), sa notification à l'assistante, sa trace ;
 *   • toute autre partie prenante : `submitAdProItem` — le poste part à la Direction Marketing (« Poste à valider »), et le
 *     cahier des charges l'attend sur le poste. C'est elle seule qui lance la prospection (15/11/2026) : son formulaire
 *     « Demander la prospection » le reprend tel quel, il ne lui reste qu'à choisir l'assistante.
 *
 * Une prospection que la Direction Marketing ne peut pas lancer tout de suite (aucune assistante désignée, refus d'une
 * garde) n'annule pas l'ajout : le poste est soumis, le cahier gardé, et la phrase dit ce qui reste à faire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const minuscule = (s: string) => s.charAt(0).toLocaleLowerCase("fr") + s.slice(1);

export async function lancerLePosteAgence(a: {
  user: SessionUser;
  itemId: string;
  owner: { parent: AdProParent; id: string };
  cahier: string;
  /** L'assistante choisie dans le formulaire ; à défaut, la seule assistante de direction active s'il n'y en a qu'une. */
  assistanteId: string | null;
  /** `submitAdProItem` — passé par l'appelant (le même fichier d'actions), pour ne pas créer de cycle d'imports. */
  soumettre: (fd: FormData) => Promise<ActionResult>;
}): Promise<string> {
  const fdId = () => { const fd = new FormData(); fd.set("id", a.itemId); return fd; };
  let raison: string | null = null;
  if ((await peutTrancherSur(a.user, a.owner)).marketing) {
    const assistantes = a.assistanteId ? [] : await assistantesDeDirection();
    const assistanteId = a.assistanteId ?? (assistantes.length === 1 ? assistantes[0]!.id : null);
    if (assistanteId) {
      const fd = fdId();
      fd.set("assistanteId", assistanteId);
      fd.set("cahierDesCharges", a.cahier);
      const r = await demanderProspection(fd);
      if (r.ok) return `Poste ajouté et soumis — ${minuscule(r.message ?? "Prospection demandée.")}`;
      raison = r.error ?? "la prospection a été refusée";
    } else {
      raison = "choisissez l'assistante de direction qui prospecte";
    }
  }
  const s = await a.soumettre(fdId());
  // Le cahier des charges ATTEND la prospection sur le poste : ni date de demande, ni assistante — la frise reste à
  // « Demander la prospection », et son formulaire le reprend.
  await prisma.adProExecutionPoste.upsert({
    where: { itemId: a.itemId },
    create: { itemId: a.itemId, cahierDesCharges: a.cahier },
    update: { cahierDesCharges: a.cahier },
  });
  if (!s.ok) {
    return `Poste ajouté en brouillon, son cahier des charges gardé — il n'a pas pu être soumis : ${minuscule(s.error ?? "soumission refusée.")}`;
  }
  return raison
    ? `Poste ajouté et soumis, son cahier des charges gardé — la prospection n'est pas encore demandée (${minuscule(raison.replace(/\.$/, ""))}) : lancez-la depuis le poste.`
    : "Poste ajouté et soumis à la Direction Marketing avec son cahier des charges : elle lancera la prospection d'agences auprès de l'assistante de direction.";
}
