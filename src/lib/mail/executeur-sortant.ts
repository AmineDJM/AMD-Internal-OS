import { enregistrerExecuteur, type PlanCompensation } from "@/lib/effets/fenetre";
import { RECTIFICATIF } from "@/lib/effets/executeurs";
import { getActiveConnection } from "@/lib/mail/connection";
import { MicrosoftGraphMailProvider } from "@/lib/mail/graph/provider";
import type { MailDraftInput } from "@/lib/mail/provider";

/**
 * L'EXÉCUTEUR « courriel.graph » DE LA FENÊTRE D'ANNULATION (K10b, décision 0038) — le courriel Microsoft différé part
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
