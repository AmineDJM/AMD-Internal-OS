"use client";

import * as React from "react";
import { Loader2, RefreshCw, FileText, ShoppingCart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { formatCurrency } from "@/lib/utils";
import type { ActionResult } from "@/lib/actions/types";
import type { VueAchatsPec } from "../../infra/requetes/achats-pec";
import { addCareBeneficiary } from "../../actions-prise-en-charge";
import { chercherMedecinsAnnuaire } from "../../actions-medecins";
import { demanderChiffragePec, homonymesAnnuairePec, repondreRemboursementPec, retirerProfessionnelPec, validerProfessionnelsPec } from "../../actions-prise-en-charge-chiffrage";
import { lancerAchatsPec, signerBcPec } from "../../actions-prise-en-charge-achats";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PRISE EN CHARGE — LE CIRCUIT D'ACHAT, À L'ÉCRAN (maquette PriseEnCharge v2, validée le 24/11/2026).
 *
 *   • « À vous » (Direction Marketing) : n professionnels chiffrés à valider — « Valider seulement » / « Valider et lancer les
 *     achats » ; ou des postes validés qui attendent leur BC — « Lancer les achats » ;
 *   • Professionnels : un champ unique qui cherche l'annuaire en direct (sinon texte libre, « Ajouter à l'annuaire ? »,
 *     homonymes proposés), « Demander son devis » coché, « Actualiser les prix » ; une ligne par professionnel — postes,
 *     montant, où il en est, « Ouvrir » (sa fiche voyageur), « Retirer », « Remboursé ? » ;
 *   • Bons de commande : n°, contenu, montant, où en est le circuit, PDF ; « Signer et cacheter » pour la Direction Marketing ;
 *   • l'historique des prix (qui, quand, ancien → nouveau).
 * Les règles et les gardes sont au serveur ; ici, on montre et on appelle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface Props {
  scope: "NATIONAL" | "INTERNATIONAL";
  requestId: string;
  vue: VueAchatsPec;
  /** Ajouter un professionnel, demander son devis : qui tient la fiche (droit d'écrire dans le module). */
  peutAjouter: boolean;
  budgetOptions: { id: string; label: string }[];
  /** Ouvre la fiche voyageur d'un professionnel (ses postes, ses pièces, ses billets). */
  onOuvrir: (beneficiaryId: string) => void;
}

const fd = (o: Record<string, string>, multi: Record<string, string[]> = {}) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  for (const [k, vs] of Object.entries(multi)) for (const v of vs) f.append(k, v);
  return f;
};
const dzd = (n: number | null) => (n == null ? "—" : formatCurrency(n));
const quand = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const TON_ETAT: Record<string, string> = {
  A_VALIDER: "font-semibold text-primary", CHIFFRAGE_DEMANDE: "text-warning", VALIDE: "text-foreground", RETIRE_APRES_ACHAT: "font-semibold text-warning",
};

type Medecin = { id: string; nom: string; specialite: string | null; etablissement: string | null };

export function AchatsPriseEnCharge({ scope, requestId, vue, peutAjouter, budgetOptions, onOuvrir }: Props) {
  const { busy, error, setError, run } = useKeyedAction();
  const [info, setInfo] = React.useState<string | null>(null);
  const [budget, setBudget] = React.useState("");
  /** Appelle l'action et garde sa phrase : la marge, le BC lancé, le remboursement se DISENT. */
  const geste = (cle: string, fn: () => Promise<ActionResult>) => run(cle, async () => {
    setInfo(null);
    const r = await fn();
    if (r.ok && r.message) setInfo(r.message);
    return r;
  });
  const base = { scope, requestId };
  const signer = vue.bcs.find((b) => b.etape === "SIGNATURE_DM" && vue.peut.piloter) ?? null;

  return (
    <div className="space-y-4" id="circuit-achat">
      {error && <Retour ton="erreur" onFermer={() => setError(null)}>{error}</Retour>}
      {info && <Retour ton="succes" onFermer={() => setInfo(null)}>{info}</Retour>}

      {vue.peut.piloter && (vue.aValider.ids.length > 0 || vue.prochainBc.postes > 0) && (
        <section aria-labelledby="pec-avous" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-primary bg-card px-4 py-4">
          <div className="min-w-0">
            <h3 id="pec-avous" className="text-base font-bold">
              {vue.aValider.ids.length > 0
                ? `À vous : ${vue.aValider.ids.length} professionnel${vue.aValider.ids.length > 1 ? "s" : ""} chiffré${vue.aValider.ids.length > 1 ? "s" : ""} à valider — ${dzd(vue.aValider.total)}`
                : `À vous : ${vue.prochainBc.postes} poste${vue.prochainBc.postes > 1 ? "s" : ""} validé${vue.prochainBc.postes > 1 ? "s" : ""} à mettre dans un BC — ${dzd(vue.prochainBc.total)}`}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {vue.aValider.ids.length > 0 ? vue.aValider.noms.join(", ") : "« Lancer les achats » crée le bon de commande numéroté suivant."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {budgetOptions.length > 0 && (
              <Select aria-label="Catégorie budgétaire du BC" value={budget} onChange={(e) => setBudget(e.target.value)} className="h-11 max-w-[16rem]">
                <option value="">Catégorie budgétaire…</option>
                {budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            )}
            {vue.aValider.ids.length > 0 && (
              <BoutonDecisif type="button" variant="outline" className="h-11" disabled={busy !== null}
                onClick={() => geste("valider", () => validerProfessionnelsPec(fd(base, { beneficiaryIds: vue.aValider.ids })))}>
                {busy === "valider" && <Loader2 className="h-4 w-4 animate-spin" />} Valider seulement
              </BoutonDecisif>
            )}
            <BoutonDecisif type="button" className="h-11" disabled={busy !== null}
              onClick={() => geste("lancer", () => vue.aValider.ids.length > 0
                ? validerProfessionnelsPec(fd({ ...base, lancer: "oui", budgetCategoryId: budget }, { beneficiaryIds: vue.aValider.ids }))
                : lancerAchatsPec(fd({ ...base, budgetCategoryId: budget })))}>
              {busy === "lancer" && <Loader2 className="h-4 w-4 animate-spin" />} {vue.aValider.ids.length > 0 ? "Valider et lancer les achats" : "Lancer les achats"}
            </BoutonDecisif>
          </div>
        </section>
      )}

      {signer && <SignatureBc bc={signer} busy={busy} geste={geste} />}

      <section aria-labelledby="pec-pros" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-3 px-4 py-4">
          <div className="flex min-w-0 flex-[1_1_26rem] flex-col gap-1.5">
            <h3 id="pec-pros" className="text-base font-semibold">Professionnels · {vue.professionnels.length}</h3>
            {peutAjouter && <AjoutProfessionnel scope={scope} requestId={requestId} busy={busy} geste={geste} />}
          </div>
          {(peutAjouter || vue.peut.piloter) && vue.professionnels.length > 0 && (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => geste("actualiser", () => demanderChiffragePec(fd({ ...base, tous: "on" })))}>
              {busy === "actualiser" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Actualiser les prix
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="bg-secondary/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-semibold">Professionnel</th>
                <th scope="col" className="px-3 py-2 font-semibold">Postes</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">Montant</th>
                <th scope="col" className="px-3 py-2 font-semibold">Où il en est</th>
                <th scope="col" className="px-4 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {vue.professionnels.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">Aucun professionnel : ajoutez-en un ci-dessus.</td></tr>
              )}
              {vue.professionnels.map((p) => (
                <tr key={p.id} className={`border-t border-border ${p.aValider ? "bg-primary/5" : ""}`}>
                  <td className="px-4 py-3">
                    <span className={`font-semibold ${p.retire ? "text-muted-foreground line-through" : ""}`}>{p.nom}</span>
                    {p.sousTitre && <span className="block text-xs text-muted-foreground">{p.sousTitre}</span>}
                  </td>
                  <td className={`px-3 py-3 ${p.retire ? "text-muted-foreground" : ""}`}>{p.postes.map((c) => c.nom).join(", ") || "—"}</td>
                  <td className={`px-3 py-3 text-right tabular-nums ${p.retire ? "text-muted-foreground" : ""}`}>{dzd(p.montant)}</td>
                  <td className={`px-3 py-3 ${TON_ETAT[p.etat.code] ?? (p.retire ? "text-muted-foreground" : "")}`}>{p.etat.libelle}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {vue.peut.montants && p.remboursements.map((r) => (
                        <span key={r.ligneId} className="inline-flex items-center gap-1 text-xs">
                          Remboursé ?
                          <BoutonDecisif type="button" size="sm" variant="outline" disabled={busy !== null} confirmation={`Remboursé — ${r.libelle}`}
                            onClick={() => geste(`r:${r.ligneId}`, () => repondreRemboursementPec(fd({ ligneId: r.ligneId, rembourse: "oui" })))}>Oui</BoutonDecisif>
                          <BoutonDecisif type="button" size="sm" variant="outline" disabled={busy !== null} confirmation={`Non remboursé — ${r.libelle}`}
                            onClick={() => geste(`r:${r.ligneId}`, () => repondreRemboursementPec(fd({ ligneId: r.ligneId, rembourse: "non" })))}>Non</BoutonDecisif>
                        </span>
                      ))}
                      {!p.retire && (vue.peut.piloter || vue.peut.retirerAvantPrevalidation) && (
                        <BoutonDecisif type="button" size="sm" variant="ghost" disabled={busy !== null} confirmation={`Retirer ${p.nom}`}
                          onClick={() => geste(`x:${p.id}`, () => retirerProfessionnelPec(fd({ beneficiaryId: p.id })))}>Retirer</BoutonDecisif>
                      )}
                      <Button type="button" size="sm" variant="outline" onClick={() => onOuvrir(p.id)}>Ouvrir</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="pec-bcs" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="px-4 py-4">
          <h3 id="pec-bcs" className="text-base font-semibold">Bons de commande</h3>
          <p className="mt-1 text-xs text-muted-foreground">Un BC signé ne se réécrit jamais : un ajout après signature part dans un BC complémentaire.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <tbody>
              {vue.bcs.map((b) => (
                <tr key={b.id} className="border-t border-border">
                  <td className="px-4 py-3 font-semibold">BC n°{b.numero}{b.reference && <span className="block text-xs font-normal text-muted-foreground">{b.reference}</span>}</td>
                  <td className="px-3 py-3">{b.contenu}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{dzd(b.montant)}</td>
                  <td className="px-3 py-3">{b.phrase}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-end gap-3">
                      {b.pdf && <a href={b.pdf} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"><FileText className="h-4 w-4" /> Voir le PDF</a>}
                      {vue.peut.montants && (b.etape === "ACHAT" || b.etape === "PAIEMENT") && (
                        <a href={b.lienAchat} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"><ShoppingCart className="h-4 w-4" /> Achats</a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="border-t border-border text-muted-foreground">
                <td className="px-4 py-3 font-semibold">BC n°{(vue.bcs.at(-1)?.numero ?? 0) + 1}</td>
                <td className="px-3 py-3" colSpan={4}>
                  {vue.prochainBc.postes > 0
                    ? `Se créera au prochain « Lancer les achats » : ${vue.prochainBc.postes} poste(s) validé(s), ${dzd(vue.prochainBc.total)}.`
                    : "Se créera au prochain « Lancer les achats », avec ce qui sera validé et pas encore dans un BC."}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {vue.historique.length > 0 && (
        <details className="rounded-xl border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold">Historique des prix · {vue.historique.length}</summary>
          <ul className="mt-3 space-y-1.5 text-sm">
            {vue.historique.map((h, i) => (
              <li key={i} className="[overflow-wrap:anywhere]">
                <span className="text-muted-foreground">{quand(h.quand)} · {h.qui ?? "—"}</span> — {h.poste} : {dzd(h.ancien)} → <strong>{dzd(h.nouveau)}</strong> <span className="text-muted-foreground">({h.motif})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

type Geste = (cle: string, fn: () => Promise<ActionResult>) => Promise<boolean>;

/** LA SIGNATURE DE LA DIRECTION MARKETING : relire, mot de passe, code de l'application — puis le BC part au centre. */
function SignatureBc({ bc, busy, geste }: { bc: VueAchatsPec["bcs"][number]; busy: string | null; geste: Geste }) {
  const [lu, setLu] = React.useState(false);
  const [mdp, setMdp] = React.useState("");
  const [code, setCode] = React.useState("");
  return (
    <section aria-labelledby="pec-signer" className="rounded-xl border border-border bg-card px-4 py-4">
      <h3 id="pec-signer" className="text-base font-semibold">À vous : signer et cacheter le BC n°{bc.numero} — {formatCurrency(bc.montant)}</h3>
      <p className="mt-1 text-sm text-muted-foreground">Signé, il part au centre Ad & Pro (visa de la Direction générale), puis à la signature des Finances.{bc.pdf && <> <a href={bc.pdf} target="_blank" rel="noreferrer" className="text-primary hover:underline">Relire le PDF</a>.</>}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={lu} onChange={(e) => setLu(e.target.checked)} className="h-4 w-4" /> J&apos;ai relu ce bon de commande</label>
        <Input type="password" autoComplete="current-password" aria-label="Mot de passe" placeholder="Mot de passe" value={mdp} onChange={(e) => setMdp(e.target.value)} className="max-w-[12rem]" />
        <Input inputMode="numeric" autoComplete="one-time-code" aria-label="Code de l'application" placeholder="Code à 6 chiffres" value={code} onChange={(e) => setCode(e.target.value)} className="max-w-[10rem]" />
        <BoutonDecisif type="button" disabled={busy !== null || !lu || !mdp || !code}
          onClick={() => geste(`s:${bc.id}`, () => signerBcPec(fd({ bcId: bc.id, lu: "oui", motDePasse: mdp, code })))}>
          {busy === `s:${bc.id}` && <Loader2 className="h-4 w-4 animate-spin" />} Signer et cacheter le BC n°{bc.numero}
        </BoutonDecisif>
      </div>
    </section>
  );
}

/**
 * LE CHAMP UNIQUE D'AJOUT : on tape un nom, l'annuaire est cherché en direct ; rien ne convient → texte libre, et « Ajouter à
 * l'annuaire ? » (les homonymes sont proposés avant toute création). « Demander son devis » est coché par défaut.
 */
function AjoutProfessionnel({ scope, requestId, busy, geste }: { scope: string; requestId: string; busy: string | null; geste: Geste }) {
  const [q, setQ] = React.useState("");
  const [resultats, setResultats] = React.useState<Medecin[]>([]);
  const [choisi, setChoisi] = React.useState<Medecin | null>(null);
  const [devis, setDevis] = React.useState(true);
  const [annuaire, setAnnuaire] = React.useState(false);
  const [homonymes, setHomonymes] = React.useState<Medecin[] | null>(null);

  React.useEffect(() => {
    if (choisi || q.trim().length < 2) { setResultats([]); return; }
    let vivant = true;
    const t = setTimeout(() => {
      chercherMedecinsAnnuaire(fd({ q: q.trim() }))
        .then((r) => { if (vivant) setResultats(r.medecins.slice(0, 8)); })
        .catch(() => { if (vivant) setResultats([]); });
    }, 250);
    return () => { vivant = false; clearTimeout(t); };
  }, [q, choisi]);

  const vider = () => { setQ(""); setChoisi(null); setResultats([]); setHomonymes(null); setAnnuaire(false); };
  const libre = () => {
    const mots = q.trim().split(/\s+/);
    return mots.length > 1 ? { firstName: mots.slice(0, -1).join(" "), lastName: mots.at(-1)! } : { firstName: "", lastName: mots[0] ?? "" };
  };
  const ajouter = (doctorId: string | null, versAnnuaire: boolean) => geste("ajout", async () => {
    const champs: Record<string, string> = { scope, requestId, ...(devis ? { demanderDevis: "on" } : {}) };
    if (doctorId) champs.doctorId = doctorId;
    else { Object.assign(champs, libre()); if (versAnnuaire) champs.ajouterAnnuaire = "on"; }
    const r = await addCareBeneficiary(undefined, fd(champs));
    if (r.ok) vider();
    return r;
  });
  const valider = async () => {
    if (choisi) return ajouter(choisi.id, false);
    if (!q.trim()) return;
    if (annuaire && homonymes === null) {
      // LES HOMONYMES D'ABORD : une fiche en double coûte plus cher qu'une question.
      const h = await homonymesAnnuairePec(fd({ nom: q.trim() })).catch(() => []);
      if (h.length > 0) { setHomonymes(h); return; }
    }
    return ajouter(null, annuaire);
  };

  return (
    <div className="space-y-2">
      <label htmlFor="pec-ajout" className="text-xs font-semibold text-muted-foreground">Ajouter un professionnel</label>
      <div className="relative flex flex-wrap items-center gap-2">
        <Input id="pec-ajout" value={choisi ? choisi.nom : q} placeholder="Tapez un nom : l'annuaire est cherché en direct"
          onChange={(e) => { setChoisi(null); setHomonymes(null); setQ(e.target.value); }}
          className="min-w-0 flex-[1_1_16rem]" autoComplete="off" />
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={devis} onChange={(e) => setDevis(e.target.checked)} className="h-4 w-4" /> Demander son devis</label>
        {!choisi && q.trim() && (
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={annuaire} onChange={(e) => { setAnnuaire(e.target.checked); setHomonymes(null); }} className="h-4 w-4" /> Ajouter à l&apos;annuaire</label>
        )}
        <Button type="button" disabled={busy !== null || (!choisi && !q.trim())} onClick={valider}>
          {busy === "ajout" && <Loader2 className="h-4 w-4 animate-spin" />} Ajouter
        </Button>
        {resultats.length > 0 && !choisi && (
          <ul role="listbox" aria-label="Médecins de l'annuaire" className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-card shadow-lg">
            {resultats.map((m) => (
              <li key={m.id} role="option" aria-selected={false}>
                <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-secondary" onClick={() => { setChoisi(m); setResultats([]); }}>
                  <span className="font-semibold">{m.nom}</span>
                  <span className="block text-xs text-muted-foreground">{[m.specialite, m.etablissement].filter(Boolean).join(" · ") || "—"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {homonymes && homonymes.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <p className="font-semibold">Déjà dans l&apos;annuaire ? Choisissez la fiche, ou créez-en une nouvelle.</p>
          <ul className="mt-1 space-y-1">
            {homonymes.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2">
                <span>{h.nom}{h.specialite ? ` · ${h.specialite}` : ""}{h.etablissement ? ` · ${h.etablissement}` : ""}</span>
                <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => ajouter(h.id, false)}>C&apos;est lui</Button>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="ghost" className="mt-1" disabled={busy !== null} onClick={() => ajouter(null, true)}>Non, créer une nouvelle fiche</Button>
        </div>
      )}
    </div>
  );
}
