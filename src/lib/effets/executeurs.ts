import type { ExecuteurEffetSortant, PlanCompensation } from "./fenetre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES EXÉCUTEURS DES EFFETS SORTANTS (K10b, décision 0038) — ce que le worker appelle quand la fenêtre est passée,
 * et la COMPENSATION de chacun après son départ.
 *
 * Une ligne par type, chargée à la demande (aucun transport n'est tiré tant qu'on n'exécute pas). Un exécuteur qui
 * lit un DOMAINE (la boîte Microsoft : `mail/connection`) ne vit pas ici — le socle ne lit aucun domaine — mais
 * s'enregistre (`enregistrerExecuteur`) depuis son domaine : `lib/mail/executeur-sortant.ts`, armé par la tâche. Un module qui
 * diffère un effet nouveau (K10a : ordre de paiement ; K10c : appel externe…) AJOUTE SA LIGNE ici — la file, la
 * fenêtre, l'annulation, l'écran et l'audit sont communs.
 *
 * La règle des compensations : on ne dit JAMAIS qu'un message parti est effacé. Un courriel se compense par un
 * RECTIFICATIF au même destinataire (différé lui aussi : annulable dans sa fenêtre) ; une notification poussée ne se
 * compense pas (elle s'est affichée) — la phrase le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const RECTIFICATIF = (sujet: string, motif: string | null) => ({
  sujet: `Rectificatif : ${sujet}`.slice(0, 300),
  texte: [
    "Bonjour,",
    "",
    `Le message « ${sujet} » qui vous a été adressé est à considérer comme annulé${motif ? ` : ${motif}` : "."}`,
    "Merci de ne pas en tenir compte. Nous vous prions de nous excuser pour ce désagrément.",
  ].join("\n"),
});

export const EXECUTEURS: Readonly<Record<string, () => Promise<ExecuteurEffetSortant>>> = {
  /** Courriel SMTP d'une boîte connectée (`mail.ts`). Charge : `{ accountId, opts }`. */
  "courriel.smtp": async () => {
    const { sendMail } = await import("@/lib/mail");
    const { prismaBrut } = await import("@/lib/prisma");
    type Charge = { accountId: string; opts: { to: string; cc?: string; subject: string; text?: string; html?: string; attachments?: { filename: string; content: Buffer; contentType?: string }[] } };
    const compte = async (id: string) => {
      const a = await prismaBrut.mailAccount.findUnique({ where: { id } });
      if (!a) throw new Error("la boîte d'envoi a été déconnectée depuis : le courriel ne part pas");
      return a;
    };
    return {
      executer: async (charge) => {
        const c = charge as Charge;
        await sendMail(await compte(c.accountId), c.opts);
      },
      compensation: async (charge, _l, motif): Promise<PlanCompensation> => {
        const c = charge as Charge;
        const r = RECTIFICATIF(c.opts.subject, motif);
        return { charge: { accountId: c.accountId, opts: { to: c.opts.to, cc: c.opts.cc, subject: r.sujet, text: r.texte } }, apercu: `« ${r.sujet} »`, phrase: `un rectificatif part à ${c.opts.to}` };
      },
    };
  },

  /** Courriel par l'API d'un fournisseur (`mail-smart.ts`). Charge : l'entrée de `sendSmartEmail`. */
  "courriel.api": async () => {
    const { sendSmartEmail } = await import("@/lib/mail-smart");
    type Charge = { to: string[]; cc?: string[]; subject: string; text: string; html?: string; replyTo?: string };
    return {
      executer: async (charge, ligne) => {
        const r = await sendSmartEmail(charge as Charge);
        if (!r.ok) throw new Error(r.error ?? "refus du fournisseur");
        // Le journal des courriels (`OutboundEmail`) le disait « en file » : il le dit parti, avec l'identifiant du fournisseur.
        const { prismaBrut } = await import("@/lib/prisma");
        await prismaBrut.outboundEmail.updateMany({ where: { providerId: `differe:${ligne.id}` }, data: { status: "SENT", providerId: r.providerId ?? null, sentAt: new Date() } });
      },
      compensation: async (charge, _l, motif): Promise<PlanCompensation> => {
        const c = charge as Charge;
        const r = RECTIFICATIF(c.subject, motif);
        return { charge: { to: c.to, cc: c.cc, subject: r.sujet, text: r.texte, replyTo: c.replyTo }, apercu: `« ${r.sujet} »`, phrase: `un rectificatif part à ${c.to.join(", ")}` };
      },
    };
  },

  /** Notification poussée (`push.ts`). Charge : `{ userId, payload }`. */
  "push": async () => {
    const { sendPushToUser } = await import("@/lib/push");
    return {
      executer: async (charge) => {
        const c = charge as { userId: string; payload: { title: string; body?: string; url?: string; tag?: string } };
        await sendPushToUser(c.userId, c.payload);
      },
      sansCompensation: "la notification poussée s'est affichée sur l'appareil du destinataire : elle ne se reprend pas (sa notification dans l'ERP, elle, est retirée par l'annulation du geste si elle n'a pas été lue)",
    };
  },
};
