"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Check, KeyRound, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkDciDuplicate, requestRegulatoryDossierAccess, type ExistantDeLaMolecule } from "@/lib/actions/regulatory-actions";
import { sansBloquer } from "@/lib/journal";

/**
 * « CETTE DCI EXISTE DÉJÀ » — dit PENDANT la saisie, pas après le clic.
 *
 * ── POURQUOI L'AVIS ARRIVE AVANT ────────────────────────────────────────────────────────────
 *
 * Découvrir le doublon dans un message d'erreur, après avoir rempli vingt champs, oblige à
 * relire un formulaire qu'on croyait fini. C'est précisément le moment où l'on force le passage
 * au lieu d'aller vérifier — et le second dossier naît quand même, sans que personne n'ait
 * regardé le premier. L'avis se lit donc à la deuxième frappe, quand corriger ne coûte rien.
 *
 * ── POURQUOI ON N'INTERDIT PAS ──────────────────────────────────────────────────────────────
 *
 * Une même DCI porte légitimement plusieurs dossiers : un autre dosage, une autre forme, un
 * autre partenaire. Le bouton ne disparaît pas, il demande une CONFIRMATION explicite — et la
 * confirmation tombe dès que la DCI est retouchée, parce qu'elle portait sur l'ancienne.
 *
 * ── ET CE QU'ON NE VOIT PAS ─────────────────────────────────────────────────────────────────
 *
 * Un dossier au pipeline est verrouillé : il existe et l'on n'a pas le droit de le voir. « Cette
 * DCI existe » sans rien montrer serait une énigme — on chercherait à l'écran un dossier
 * invisible et l'on conclurait à une panne. On offre donc le geste qui débloque, et lui seul :
 * le bouton n'apparaît QUE s'il y a vraiment quelque chose hors de portée.
 */
export interface DciDuplicateCheck {
  notice: string | null;
  canRequestAccess: boolean;
  /** Ce qui existe déjà pour cette molécule : dossiers visibles et produits du référentiel (Direction, 06/10). */
  existants: ExistantDeLaMolecule[];
  acknowledged: boolean;
  acknowledge: () => void;
  /** Le formulaire doit-il retenir sa soumission ? (un avis non lu) */
  blocking: boolean;
  /** Rejoue la vérification — après un refus du serveur, quand l'avis n'était pas encore là. */
  recheck: () => void;
}

export function useDciDuplicate(dci: string): DciDuplicateCheck {
  const [notice, setNotice] = React.useState<string | null>(null);
  const [canRequestAccess, setCanRequestAccess] = React.useState(false);
  const [existants, setExistants] = React.useState<ExistantDeLaMolecule[]>([]);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [tick, setTick] = React.useState(0);

  const propre = dci.trim();

  React.useEffect(() => {
    if (propre.length < 3) {
      setNotice(null);
      setCanRequestAccess(false);
      setExistants([]);
      setAcknowledged(false);
      return;
    }
    let vivant = true;
    // Une DCI se tape lettre par lettre : sans ce délai, on interrogerait le référentiel à
    // chaque frappe pour une seule réponse utile — et les réponses arriveraient dans le désordre.
    const t = setTimeout(async () => {
      const r = await checkDciDuplicate(propre).catch(sansBloquer("dci-duplicate-banner.useDciDuplicate.checkDciDuplicate", null));
      if (!vivant) return;
      setNotice(r?.notice ?? null);
      setCanRequestAccess(r?.canRequestAccess ?? false);
      setExistants(r?.existants ?? []);
      // LA DCI A CHANGÉ : l'accord précédent portait sur une autre molécule, il ne vaut plus.
      setAcknowledged(false);
    }, 400);
    return () => { vivant = false; clearTimeout(t); };
  }, [propre, tick]);

  return {
    notice,
    canRequestAccess,
    existants,
    acknowledged,
    acknowledge: () => setAcknowledged(true),
    blocking: notice !== null && !acknowledged,
    recheck: () => setTick((n) => n + 1),
  };
}

export function DciDuplicateBanner({ dci, check, onPartirDuProduit }: {
  dci: string;
  check: DciDuplicateCheck;
  /** Partir d'un produit existant : le formulaire reprend son identité (dosage, forme, conditionnement). */
  onPartirDuProduit?: (identite: NonNullable<ExistantDeLaMolecule["identite"]>) => void;
}) {
  const [envoi, setEnvoi] = React.useState(false);
  const [reponse, setReponse] = React.useState<string | null>(null);

  if (!check.notice) return null;

  const demanderAcces = async () => {
    setEnvoi(true);
    setReponse(null);
    const r = await requestRegulatoryDossierAccess(dci).catch(sansBloquer("dci-duplicate-banner.demanderAcces.requestRegulatoryDossierAccess", null));
    setEnvoi(false);
    setReponse(r?.ok ? (r.message ?? "Demande transmise.") : (r?.error ?? "L'envoi a échoué."));
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{check.notice}</span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {check.canRequestAccess && (
          <Button type="button" variant="outline" size="sm" onClick={demanderAcces} disabled={envoi}>
            {envoi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
            Demander l&apos;accès
          </Button>
        )}
        {check.acknowledged ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900">
            <Check className="h-3.5 w-3.5" /> Vérifié — la création est débloquée.
          </span>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={check.acknowledge}>
            Créer un nouveau produit
          </Button>
        )}
      </div>

      {check.existants.length > 0 && (
        <ul className="space-y-1 border-t border-amber-200 pt-2">
          {check.existants.map((e) => (
            <li key={`${e.nature}-${e.id}`} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium">{e.nature === "DOSSIER" ? "Dossier" : "Produit"}</span>
              <span className="font-medium">{e.libelle}</span>
              <span className="text-amber-800">{e.detail}</span>
              {e.nature === "DOSSIER" ? (
                <Link href={`/regulatory/${e.id}`} className="inline-flex items-center gap-1 py-1.5 underline sm:py-0"><ExternalLink className="h-3 w-3" /> Ouvrir ce dossier</Link>
              ) : e.identite && onPartirDuProduit ? (
                <button type="button" className="py-1.5 underline sm:py-0" onClick={() => { onPartirDuProduit(e.identite!); check.acknowledge(); }}>Partir de ce produit</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {reponse && <p className="text-xs">{reponse}</p>}
    </div>
  );
}
