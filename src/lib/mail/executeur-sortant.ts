import { enregistrerExecuteur, type PlanCompensation } from "@/lib/effets/fenetre";
import { RECTIFICATIF } from "@/lib/effets/executeurs";
import { getActiveConnection } from "@/lib/mail/connection";
import { MicrosoftGraphMailProvider } from "@/lib/mail/graph/provider";
import type { MailDraftInput } from "@/lib/mail/provider";

/**
 * L'EXÉCUTEUR « courriel.graph » DE LA FENÊTRE D'ANNULATION (K10b, décision 0040) — le courriel Microsoft différé part
 * par la boîte de la personne, relue à l'échéance (jeton frais) ; sa compensation est un rectificatif au même
 * destinataire, différé lui aussi. Il vit dans le domaine `mail` (le socle `effets/` ne lit aucun domaine) et
 * s'enregistre à l'appel — la tâche `effets.sortants` l'arme avant chaque passage.
 */
type Charge = { address: string; input: MailDraftInput };

async function fournisseur(c: Charge, userId: string | null): Promise<MicrosoftGraphMailProvider> {
  const conn = userId ? await getActiveConnection(userId) : null;
  if (!conn || conn.address.toLowerCase() !== c.address.toLowerCase()) throw new Error("la boîte Microsoft a été déconnectée depuis : le courriel ne part pas");
  return new MicrosoftGraphMailProvider(conn.accessToken, conn.address);
}

export function enregistrerExecuteurGraph(): void {
  enregistrerExecuteur("courriel.graph", {
    executer: async (charge, ligne) => {
      const c = charge as Charge;
      await (await fournisseur(c, ligne.principalId)).send(c.input);
    },
    compensation: async (charge, _l, motif): Promise<PlanCompensation> => {
      const c = charge as Charge;
      const r = RECTIFICATIF(c.input.subject, motif);
      const input: MailDraftInput = { to: c.input.to, cc: c.input.cc, subject: r.sujet, bodyHtml: r.texte.split("\n").map((l) => `<p>${l.replace(/[<>&]/g, "")}</p>`).join("") };
      return { charge: { address: c.address, input }, apercu: `« ${r.sujet} »`, phrase: `un rectificatif part à ${c.input.to.map((a) => a.address).join(", ")}` };
    },
  });
}

/**
 * LES GESTES MICROSOFT QUI ONT LIEU TOUT DE SUITE ET SE DÉFONT (K10b) — marquer lu / non lu, déplacer, poser un
 * brouillon. `executer` rejoue l'original (rétablir), `compensation` fait l'INVERSE (annuler), avec la boîte de la
 * personne relue au moment du geste. La phrase dit ce qui a été fait — chez Microsoft, rien n'est « effacé ».
 */
type Lu = { address: string; messageId: string; lu: boolean; avant: boolean };
type Deplace = { address: string; messageId: string; versDossier: string; depuisDossier: string };
type Brouillon = { address: string; draftId: string; cree: boolean; apres: MailDraftInput; avant: MailDraftInput | null };

export function enregistrerInversesGraph(): void {
  enregistrerExecuteur("inverse.graph.lu", {
    executer: async (charge, l) => { const c = charge as Lu; await (await fournisseur(c as never, l.principalId)).setRead(c.messageId, c.lu); },
    compensation: async (charge, l) => {
      const c = charge as Lu;
      await (await fournisseur(c as never, l.principalId)).setRead(c.messageId, c.avant);
      return { fait: c.avant ? "Le message est remis « lu »." : "Le message est remis « non lu »." };
    },
  });
  enregistrerExecuteur("inverse.graph.deplace", {
    executer: async (charge, l) => {
      const c = charge as Deplace;
      await (await fournisseur(c as never, l.principalId)).move(c.messageId, c.versDossier);
    },
    compensation: async (charge, l) => {
      const c = charge as Deplace;
      // Un déplacement change l'identifiant chez Microsoft : celui d'après le retour est gardé pour pouvoir rejouer.
      const retour = await (await fournisseur(c as never, l.principalId)).move(c.messageId, c.depuisDossier);
      return { fait: "Le message est revenu dans son dossier d'origine.", charge: { ...c, messageId: retour.id } };
    },
  });
  enregistrerExecuteur("inverse.graph.brouillon", {
    executer: async (charge, l) => {
      const c = charge as Brouillon;
      const p = await fournisseur(c as never, l.principalId);
      if (!c.cree) { await p.updateDraft(c.draftId, c.apres); return; }
      const { id } = await p.createDraft(c.apres);
      return { charge: { ...c, draftId: id } };
    },
    compensation: async (charge, l) => {
      const c = charge as Brouillon;
      const p = await fournisseur(c as never, l.principalId);
      if (c.cree || !c.avant) { await p.delete(c.draftId); return { fait: "Le brouillon créé est mis à la corbeille de la boîte." }; }
      await p.updateDraft(c.draftId, c.avant);
      return { fait: "Le brouillon retrouve son contenu d'avant." };
    },
  });
}
