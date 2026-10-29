"use client";

import * as React from "react";
import Link from "next/link";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { AlertCircle, ExternalLink, FilePen, Loader2, ShieldCheck, Send, Undo2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adresserBCAuCentre } from "@/lib/actions/legal-actions";
import { signerBonDeCommande, renvoyerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import {
  LIBELLE_CENTRE_BC, LIBELLE_ETAT_BC, CHEMIN_CENTRE_BC, reserveBC, reserveEtapeBC, LIBELLE_ETAPE_BC,
  type CentreBC, type EtatPorteBC, type PorteBC, type EtapeBC,
} from "@/lib/bons-de-commande/regle";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * LA PORTE D'UN BON DE COMMANDE, SUR SA FICHE (§118.148).
 *
 * « Un BC passe par un centre de validation » ne se croit pas sur parole : la fiche dit LEQUEL
 * (ou, sous le seuil des bons de commande, qu'il va directement à la signature des Finances —
 * §118.149), où le BC en est, et le motif du centre quand il a refusé ou demandé une correction.
 * Sans elle, la personne qui a enregistré le BC devrait aller chercher la réponse dans un centre
 * où elle ne siège pas — c'est-à-dire ne jamais la trouver.
 *
 * Et un BC SANS porte (enregistré avant la règle, ou dont l'aiguillage a échoué) porte ici le
 * geste qui le rattrape. La règle pure vit au socle et ne lit rien : ce composant client peut
 * l'importer sans tirer la base dans le navigateur.
 *
 * DEPUIS LE SEUIL ET LA SIGNATURE (§118.149), la fiche dit le BC DE BOUT EN BOUT : validé par tel
 * centre ou sous le seuil, puis « à signer » ou signé — par qui, quand. Un BC sous le seuil n'a
 * pas de porte, et sans cette phrase la fiche dirait « passé par aucun centre » d'un BC qui n'avait
 * justement à passer par aucun — un faux reproche. Les Finances signent ICI aussi, par la même
 * action que dans leur file.
 */

const TON: Record<EtatPorteBC, "warning" | "success" | "danger" | "info"> = {
  EN_ATTENTE: "warning",
  VALIDE: "success",
  REFUSE: "danger",
  A_REVOIR: "info",
};

export function BonDeCommandeGate({
  documentId, porte, centreAttendu, canAddress, siegeAuCentre,
  etape, seuil, validationRequise, signeLe, signePar, renvoi, peutSigner,
}: {
  documentId: string;
  porte: PorteBC | null;
  /** Le centre que l'origine du BC désigne — celui où il ira s'il n'a pas encore de porte. */
  centreAttendu: CentreBC;
  canAddress: boolean;
  /** La personne siège-t-elle au centre de la porte ? Le lien n'est offert qu'à elle. */
  siegeAuCentre: boolean;
  /** L'étape du BC de bout en bout (§118.149) — lue par `etatDuBC`, comme la file des Finances. */
  etape: EtapeBC;
  /** Le seuil de validation en vigueur — pour dire POURQUOI un BC n'a vu aucun centre. */
  seuil: number;
  validationRequise: boolean;
  signeLe: string | null;
  signePar: string | null;
  /** Renvoyé à son émetteur par un signataire (audit 360°, R09) : qui, quand, et ce qu'il faut corriger. */
  renvoi: { le: string; par: string | null; note: string | null } | null;
  /** La personne peut-elle signer (« Modifier » sur le module « Bons de commande », §118.176) ? */
  peutSigner: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<"ADRESSER" | "SIGNER" | "RENVOYER" | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  // RENVOYER AU LIEU DE SIGNER (audit 360°, R09) : le motif est exigé, à l'écran comme à l'action.
  const [motifRenvoi, setMotifRenvoi] = React.useState<string | null>(null);
  // LE BC SIGNÉ SUR PAPIER (Direction, 06/10) : copie signée et signataire exigés, comme dans la file.
  const [signataire, setSignataire] = React.useState("");
  const [copie, setCopie] = React.useState<File | null>(null);

  const agir = async (quoi: "ADRESSER" | "SIGNER" | "RENVOYER") => {
    setBusy(quoi); setErr(null); setMsg(null);
    const f = new FormData();
    f.set("id", documentId);
    if (quoi === "RENVOYER") f.set("note", motifRenvoi ?? "");
    if (quoi === "SIGNER") {
      f.set("signataire", signataire.trim());
      if (copie) f.set("copieSignee", copie);
    }
    try {
      const r = quoi === "ADRESSER" ? await adresserBCAuCentre(f)
        : quoi === "SIGNER" ? await signerBonDeCommande(f)
          : await renvoyerBonDeCommande(f);
      if (r.ok) { setMsg(r.message ?? null); setMotifRenvoi(null); rafraichir(); }
      else setErr(r.error ?? (quoi === "ADRESSER" ? "L'envoi au centre a échoué." : quoi === "SIGNER" ? "La signature a échoué." : "Le renvoi a échoué."));
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(null);
    }
  };

  const centre = porte?.centre ?? centreAttendu;
  const reserve = porte ? reserveBC(porte) : null;
  const aSigner = etape === "A_SIGNER";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> Validation et signature du bon de commande
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {/* L'ÉTAPE, DE BOUT EN BOUT — la même que dans le module « Bons de commande ». */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={etape === "SIGNE" ? "success" : etape === "REFUSE" ? "danger" : etape === "A_SIGNER" ? "info" : "warning"} dot={false}>
            {LIBELLE_ETAPE_BC[etape]}
          </Badge>
          {etape === "SIGNE" && signeLe && (
            <span className="text-muted-foreground">
              le {new Date(signeLe).toLocaleDateString("fr-FR")}{signePar ? ` par ${signePar}` : ""} — il peut partir chez le fournisseur.
            </span>
          )}
        </div>
        {porte ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TON[porte.etat]} dot={false}>{LIBELLE_ETAT_BC[porte.etat]}</Badge>
              <span className="text-muted-foreground">
                {/* Le centre, NOMMÉ : « en attente » tout seul ne dit pas qui relancer. */}
                au {LIBELLE_CENTRE_BC[porte.centre]}
                {porte.source === "POSTE" && " — décidé sur la demande de bon de commande du poste Ad & Pro"}
              </span>
            </div>
            {porte.note && (
              <p className="rounded-lg bg-secondary/40 px-2.5 py-1.5 text-xs [overflow-wrap:anywhere]">
                <strong>Motif du centre :</strong> {porte.note}
              </p>
            )}
            {reserve && <p className="text-xs text-muted-foreground">{reserve}</p>}
            {siegeAuCentre && porte.etat === "EN_ATTENTE" && (
              <Link href={CHEMIN_CENTRE_BC[centre]} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                Décider depuis le {LIBELLE_CENTRE_BC[centre]} <ExternalLink className="h-3 w-3" />
              </Link>
            )}
          </>
        ) : etape === "A_SIGNER" || etape === "SIGNE" || etape === "A_CORRIGER" ? (
          // SOUS LE SEUIL : aucun centre n'avait à le voir — la fiche le dit, sinon elle
          // reprocherait à ce BC d'avoir sauté une validation qu'il n'avait pas à passer.
          <p className="text-muted-foreground">
            {seuil > 0
              ? <>Sous le seuil de validation des bons de commande ({seuil.toLocaleString("fr-FR")} DZD) : aucun centre n&apos;avait à le valider.</>
              : <>Aucun centre de validation ne l&apos;a vu.</>}
          </p>
        ) : (
          <>
            <p>
              {etape === "HORS_CIRCUIT" && !validationRequise
                ? <>Ce bon de commande est antérieur au circuit de validation et de signature. Sous le seuil, il ira directement à la signature des Finances.</>
                : <>Ce bon de commande n&apos;est passé par <strong>aucun</strong> centre de validation. Il n&apos;engage
                  pas la société tant qu&apos;il n&apos;a pas été validé : d&apos;après son origine, il revient au{" "}
                  <strong>{LIBELLE_CENTRE_BC[centreAttendu]}</strong>.</>}
            </p>
            {canAddress && (
              <Button size="sm" variant="primary" onClick={() => void agir("ADRESSER")} disabled={busy !== null}>
                {busy === "ADRESSER" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {validationRequise ? `Adresser au ${LIBELLE_CENTRE_BC[centreAttendu]}` : "Envoyer à la signature des Finances"}
              </Button>
            )}
          </>
        )}
        {aSigner && (
          <div className="space-y-2 rounded-lg bg-secondary/40 px-3 py-2">
            <p className="text-xs">{reserveEtapeBC("A_SIGNER", porte, seuil)}</p>
            {peutSigner && motifRenvoi === null && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="space-y-1 text-xs">
                  <span className="font-medium">BC signé (scan ou photo) — obligatoire</span>
                  <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*" aria-label="Bon de commande signé" onChange={(e) => setCopie(e.target.files?.[0] ?? null)} className="block w-full text-xs" />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="font-medium">Signé par — obligatoire</span>
                  <Input value={signataire} onChange={(e) => setSignataire(e.target.value)} placeholder="Nom et fonction du signataire" aria-label="Signataire" />
                </label>
              </div>
            )}
            {peutSigner && (
              <div className="flex flex-wrap items-center gap-2">
                <BoutonDecisif size="sm" onClick={() => void agir("SIGNER")} disabled={busy !== null || motifRenvoi !== null || !copie || !signataire.trim()}>
                  {busy === "SIGNER" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePen className="h-4 w-4" />}
                  Enregistrer le BC signé
                </BoutonDecisif>
                {motifRenvoi === null && (
                  <Button size="sm" variant="secondary" onClick={() => setMotifRenvoi("")} disabled={busy !== null}>
                    <Undo2 className="h-4 w-4" /> Renvoyer à l&apos;émetteur
                  </Button>
                )}
              </div>
            )}
            {peutSigner && motifRenvoi !== null && (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={motifRenvoi} onChange={(e) => setMotifRenvoi(e.target.value)} aria-label="Ce qu'il faut corriger"
                  placeholder="Ce qu'il faut corriger (obligatoire)" className="min-w-0 flex-1 basis-full sm:basis-auto"
                />
                <BoutonDecisif size="sm" variant="secondary" onClick={() => void agir("RENVOYER")} disabled={busy !== null || !motifRenvoi.trim()}>
                  {busy === "RENVOYER" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Confirmer le renvoi
                </BoutonDecisif>
                <Button size="sm" variant="ghost" onClick={() => setMotifRenvoi(null)} disabled={busy !== null}>Annuler</Button>
              </div>
            )}
          </div>
        )}
        {etape === "A_CORRIGER" && (
          // RENVOYÉ À SON ÉMETTEUR (audit 360°, R09) : qui, quand, ce qu'il faut corriger — et le geste
          // qui le rend à la signature (la modification de la pièce, depuis cette fiche).
          <div className="space-y-1 rounded-lg bg-warning/10 px-3 py-2 text-xs">
            {renvoi && (
              <p>
                Renvoyé le {new Date(renvoi.le).toLocaleDateString("fr-FR")}{renvoi.par ? ` par ${renvoi.par}` : ""}
                {renvoi.note ? <> — à corriger : « {renvoi.note} »</> : null}
              </p>
            )}
            <p>{reserveEtapeBC("A_CORRIGER", porte, seuil)}</p>
          </div>
        )}
        {msg && <p className="rounded-lg bg-success/10 px-3 py-2 text-xs text-foreground">{msg}</p>}
        {err && (
          <p className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" /> {err}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
