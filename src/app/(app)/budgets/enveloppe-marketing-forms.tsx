"use client";

/**
 * BUDGETS DES PÔLES — les deux tiroirs d'un pôle (Marketing, Regulatory, Operations & Sales) : créer une enveloppe, la
 * régler.
 *
 * Volontairement plus courts que ceux de Budgets : ni listes d'accès ni délégations (le module du pôle suffit à voir et
 * gérer ses enveloppes ; les accès fins restent au Super Admin, dans Budgets). Une enveloppe se crée pour une ANNÉE,
 * avec ou sans les catégories d'office du pôle ; la BU (et, hors Operations & Sales, le produit) est facultative.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { InfoBulle } from "@/components/ui/info-bulle";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { createPoleEnvelope, updatePoleEnvelope, deletePoleEnvelope } from "@/lib/actions/budget-pole-actions";
import type { BudgetOverview } from "@/lib/queries/budget";
import { DOMAINES, type DomainePole } from "@/lib/budget/domaines";

export interface RattachementOptions {
  businessUnits: { id: string; nom: string }[];
  produits: { id: string; nom: string }[];
}

type Resultat = { ok: boolean; error?: string };

/** Ce que chaque pôle crée d'office, et comment il nomme sa première enveloppe. */
const MODELE: Record<DomainePole, { titre: string; exemple: string; libelle: string; aide: string }> = {
  MARKETING: {
    titre: "Nouvelle enveloppe marketing", exemple: "Ad & Pro", libelle: "Catégories Ad & Pro",
    aide: "Crée Sponsoring, Événements, Congrès nationaux, Congrès internationaux, Matériel promotionnel et Autres, chacune liée à son module : les postes Ad & Pro accordés s'y rangent. Décochez pour une enveloppe libre.",
  },
  REGULATORY: {
    titre: "Nouvelle enveloppe Regulatory", exemple: "Frais d'enregistrement (BV)", libelle: "Catégories BV 25 % et 75 %",
    aide: "Crée « BV 25 % (préparation) » et « BV 75 % (avant dépôt) » : les BV demandés depuis les dossiers s'y rangent selon leur part. Décochez pour une enveloppe libre.",
  },
  OPERATIONS: {
    titre: "Nouvelle enveloppe Operations & Sales", exemple: "Operations & Sales", libelle: "Catégories d'office (masse salariale en tête)",
    aide: "Crée la masse salariale de la force de vente (une sous-catégorie par BU, alimentée par la paie), puis Véhicules & carburant, Frais de déplacement terrain, Téléphonie, Logistique et Formations commerciales. Ad & Pro n'y est pas : il relève du Budget Marketing.",
  },
};

function useEnvoi() {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const envoyer = async (fn: () => Promise<Resultat>, onOk?: () => void) => {
    setBusy(true); setErr(null);
    const r = await fn();
    setBusy(false);
    if (r.ok) { onOk?.(); rafraichir(); } else setErr(r.error ?? "Erreur.");
  };
  return { busy: busy || enCours, err, envoyer };
}

/** La BU, et le produit hors Operations & Sales — là, la Business Unit dit déjà les produits (Direction, 10/2026). */
function ChampsRattachement({ options, bu, produit, avecProduit = true }: { options: RattachementOptions; bu?: string | null; produit?: string | null; avecProduit?: boolean }) {
  return (
    <>
      <div className="space-y-1.5">
        <Label>Business Unit</Label>
        <Select name="businessUnitId" defaultValue={bu ?? ""}>
          <option value="">— Aucune —</option>
          {options.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.nom}</option>)}
        </Select>
      </div>
      {avecProduit && (
        <div className="space-y-1.5">
          <Label>Produit</Label>
          <Select name="productId" defaultValue={produit ?? ""}>
            <option value="">— Aucun —</option>
            {options.produits.map((p) => <option key={p.id} value={p.id}>{p.nom}</option>)}
          </Select>
        </div>
      )}
    </>
  );
}

export function NouvelleEnveloppePole({ domaine, options }: { domaine: DomainePole; options: RattachementOptions }) {
  const [open, setOpen] = React.useState(false);
  const { busy, err, envoyer } = useEnvoi();
  const annee = new Date().getFullYear();
  const m = MODELE[domaine];
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Nouvelle enveloppe</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={m.titre} width="md">
        <form action={(fd) => { fd.set("domaine", domaine); envoyer(() => createPoleEnvelope(fd), () => setOpen(false)); }} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Nom</Label>
            <Input name="name" required placeholder={`${m.exemple} ${annee}`} />
          </div>
          <div className="space-y-1.5">
            <Label>Année</Label>
            <Input name="annee" type="number" inputMode="numeric" min={2000} max={2100} defaultValue={annee} />
          </div>
          <div className="space-y-1.5">
            <Label>Montant (DZD)</Label>
            <Input name="totalAmount" type="number" inputMode="decimal" step="any" min={0} placeholder="0" />
          </div>
          <ChampsRattachement options={options} avecProduit={domaine !== "OPERATIONS"} />
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            {domaine === "MARKETING"
              ? <input type="checkbox" name="adPro" value="on" defaultChecked className="h-4 w-4 rounded border-input" />
              : <input type="checkbox" name="categoriesParDefaut" value="on" defaultChecked className="h-4 w-4 rounded border-input" />}
            {m.libelle}
            <InfoBulle label={`À propos : ${m.libelle}`}>{m.aide}</InfoBulle>
          </label>
          <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea name="notes" rows={2} /></div>
          {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
          <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Créer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

export function EnveloppePoleSheet({ domaine, envelope, options, canDelete, onClose }: {
  domaine: DomainePole;
  envelope: BudgetOverview["envelope"];
  options: RattachementOptions;
  canDelete: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { busy, err, envoyer } = useEnvoi();
  const d10 = (iso: string) => iso.slice(0, 10);
  return (
    <Sheet open onClose={onClose} title="Modifier l'enveloppe" width="md">
      <form action={(fd) => { fd.set("id", envelope.id); envoyer(() => updatePoleEnvelope(fd), onClose); }} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2"><Label>Nom</Label><Input name="name" required defaultValue={envelope.name} /></div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Montant (DZD)</Label>
          <Input name="totalAmount" type="number" inputMode="decimal" step="any" min={0} defaultValue={envelope.total} />
        </div>
        <div className="space-y-1.5"><Label>Début</Label><Input name="periodStart" type="date" defaultValue={d10(envelope.periodStart)} /></div>
        <div className="space-y-1.5"><Label>Fin</Label><Input name="periodEnd" type="date" defaultValue={d10(envelope.periodEnd)} /></div>
        <ChampsRattachement options={options} bu={envelope.businessUnitId} produit={envelope.productId} avecProduit={domaine !== "OPERATIONS"} />
        <div className="space-y-1.5 sm:col-span-2"><Label>Notes</Label><Textarea name="notes" defaultValue={envelope.notes ?? ""} rows={2} /></div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="hidden" name="isActive" value="off" />
          <input type="checkbox" name="isActive" value="on" defaultChecked={envelope.isActive} className="h-4 w-4 rounded border-input" /> Enveloppe active
        </label>
        {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          {canDelete ? (
            <Button
              type="button" variant="ghost" className="text-destructive"
              onClick={() => {
                if (!window.confirm("Supprimer cette enveloppe et ses catégories ? Les écritures imputées repasseront « à imputer » ; une enveloppe qui porte des dépenses budgétaires ne se supprime pas.")) return;
                const fd = new FormData(); fd.set("id", envelope.id);
                envoyer(() => deletePoleEnvelope(fd), () => { onClose(); router.push(DOMAINES[domaine].chemin); });
              }}
            >
              <Trash2 className="h-4 w-4" /> Supprimer
            </Button>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
            <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </div>
      </form>
    </Sheet>
  );
}
