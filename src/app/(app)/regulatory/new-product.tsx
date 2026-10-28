"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, AlertCircle } from "lucide-react";
import { createRegulatoryProduct, type ActionResult } from "@/lib/actions/regulatory-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { TextField, TextAreaField, SelectField, optionsFromMap } from "@/components/shared/form-fields";
import { DciAssociationField } from "./dci-field";
import { DciDuplicateBanner, useDciDuplicate } from "./dci-duplicate-banner";
import { CtdALaCreation } from "./ctd-creation";
import { useBackgroundUpload } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { construireEnvoi, type EntreeDepot } from "@/components/documents/envoi-document";
import { CTD_INITIALE_CATEGORIE, CTD_INITIALE_ENTITE, CTD_INITIALE_ETAPE } from "@/lib/regulatory/ctd-initiale";
import { MANUFACTURING_STATUS, REGULATORY_CATEGORY, PRODUCT_CHANNEL, PRIORITY, REGULATORY_STATUS, ROLE_LABELS, PHARMA_FORM, DOSAGE_UNIT } from "@/lib/labels";

interface UserOption {
  id: string;
  name: string;
  role: string;
}

/**
 * `lockOnCreate` — le MÊME formulaire, ouvert depuis le pipeline : le dossier naît verrouillé,
 * donc à l'étude et invisible de l'équipe. Un second formulaire recopié aurait divergé du
 * premier au premier champ ajouté ; c'est le même, avec une case de plus.
 */
export function NewProductButton({ users, suppliers, companies, lockOnCreate = false }: { users: UserOption[]; suppliers: { id: string; name: string }[]; companies: { id: string; name: string; shortName: string | null }[]; lockOnCreate?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    createRegulatoryProduct,
    undefined,
  );
  const [submitting, setSubmitting] = React.useState(false);
  // Verrou SYNCHRONE anti double-soumission (double-clic / double Entrée avant re-render).
  const lock = React.useRef(false);

  // La DCI en cours de saisie, et ce que le référentiel en dit. Le champ la recompose (« A + B »)
  // exactement comme l'action serveur : deux recompositions différentes signaleraient un doublon
  // à l'écran sans que le serveur en voie un, ou l'inverse.
  const [dci, setDci] = React.useState("");
  const doublon = useDciDuplicate(dci);
  const recheck = doublon.recheck;

  // LA CTD INITIALE choisie dans le formulaire (§118.213) : gardée ici, confiée au gestionnaire d'envois
  // global UNE fois le dossier créé — vers l'étape 1, sans retenir la création.
  const { enqueue } = useBackgroundUpload();
  const limites = useLimitesEnvoi();
  const [ctd, setCtd] = React.useState<EntreeDepot[]>([]);
  const ctdRef = React.useRef<EntreeDepot[]>([]);
  ctdRef.current = ctd;
  const limitesRef = React.useRef(limites);
  limitesRef.current = limites;
  // Un résultat d'action ne se traite qu'UNE fois : l'effet rejoue quand d'autres dépendances changent, et
  // une CTD choisie pour un AUTRE dossier plus tard ne doit jamais partir vers celui-ci.
  const traite = React.useRef<unknown>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  // LA CTD INITIALE EST OBLIGATOIRE dans le suivi (Direction, 06/10) ; au pipeline, elle viendra plus tard.
  const ctdManquante = !lockOnCreate && ctd.length === 0;

  /** Partir d'un produit existant : son identité remplit le formulaire (seulement les valeurs que les menus connaissent). */
  const partirDuProduit = React.useCallback((id: { dosage: string | null; dosageUnit: string | null; form: string | null; packaging: string | null }) => {
    const f = formRef.current;
    if (!f) return;
    const poser = (name: string, v: string | null) => {
      const el = f.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
      if (!el || !v) return;
      if (el instanceof HTMLSelectElement) {
        const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === v.toLowerCase());
        if (opt) el.value = opt.value;
      } else el.value = v;
    };
    poser("dosage", id.dosage); poser("dosageUnit", id.dosageUnit); poser("pharmaceuticalForm", id.form); poser("packaging", id.packaging);
  }, []);

  React.useEffect(() => {
    if (state?.ok) {
      if (traite.current === state) return;
      traite.current = state;
      const aEnvoyer = ctdRef.current;
      if (state.id && aEnvoyer.length > 0) {
        enqueue(construireEnvoi({
          cible: { entityType: CTD_INITIALE_ENTITE, entityId: state.id, category: CTD_INITIALE_CATEGORIE, confidentiality: "INTERNAL", stepKey: CTD_INITIALE_ETAPE, ctd: true },
          entrees: aEnvoyer,
          limites: limitesRef.current,
        }));
        setCtd([]);
      }
      setOpen(false);
      setSubmitting(false);
      router.refresh();
      if (state.id) router.push(`/regulatory/${state.id}${aEnvoyer.length > 0 ? "?ctd=envoi" : ""}`);
    } else if (state?.error) {
      setSubmitting(false);
      lock.current = false; // échec → on autorise une nouvelle tentative
      // LE SERVEUR A REFUSÉ : si c'est pour un doublon, l'avis n'était pas encore arrivé à
      // l'écran (saisie trop rapide, requête perdue). On le redemande — sans quoi le message
      // s'afficherait sans le bouton qui permet de passer outre, et l'on serait bloqué.
      recheck();
    }
  }, [state, router, recheck, enqueue]);

  const userOptions = users.map((u) => ({
    value: u.id,
    label: `${u.name} — ${ROLE_LABELS[u.role] ?? u.role}`,
  }));

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
        {lockOnCreate ? "Nouveau dossier au pipeline" : "Nouveau dossier"}
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={lockOnCreate ? "Nouveau dossier au pipeline" : "Nouveau dossier réglementaire"}
        description={lockOnCreate
          ? "Créé VERROUILLÉ : à l'étude, visible du seul Super Admin. Ouvrir le cadenas le fera passer dans « À traiter »."
          : "Le workflow en 17 étapes est créé automatiquement."}
        width="lg"
      >
        <form
          ref={formRef}
          action={(fd) => {
            if (lock.current) return;
            lock.current = true;
            setSubmitting(true);
            formAction(fd);
          }}
          className="space-y-4"
        >
          {/* La destination du dossier, portée par le formulaire lui-même : c'est l'écran d'où
              l'on crée qui décide, pas une case que l'on peut oublier de cocher. */}
          {lockOnCreate && <input type="hidden" name="lock" value="1" />}
          <input type="hidden" name="ctdFichiers" value={String(ctd.length)} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SelectField label="Catégorie" name="category" options={optionsFromMap(REGULATORY_CATEGORY)} defaultValue="MEDICINE" />
            <SelectField label="Canal (Ville / Hôpital)" name="channel" options={optionsFromMap(PRODUCT_CHANNEL)} defaultValue="BOTH" />
            <SelectField label="Entité" name="companyId" required options={companies.map((c) => ({ value: c.id, label: c.shortName || c.name }))} placeholder="— Choisir l'entité —" defaultValue={companies.length === 1 ? companies[0].id : ""} />
            <DciAssociationField onDciChange={setDci} />
            <TextField label="Nom commercial envisagé" name="brandName" placeholder="Ex. Adventor" className="sm:col-span-2" />
            <TextField label="Dosage" name="dosage" placeholder="20" />
            <SelectField label="Unité" name="dosageUnit" options={optionsFromMap(DOSAGE_UNIT)} placeholder="—" />
            <SelectField label="Forme pharmaceutique" name="pharmaceuticalForm" options={optionsFromMap(PHARMA_FORM)} placeholder="—" />
            <TextField label="Conditionnement" name="packaging" placeholder="B/30" />
            <TextField label="Classe thérapeutique" name="therapeuticClass" placeholder="Hypolipémiant" />
            <SelectField label="Fournisseur" name="supplierId" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} placeholder="— Aucun —" />
            <TextField label="Laboratoire partenaire (optionnel)" name="partnerLab" placeholder="Ex. Pharma Lab" />
            <TextField label="Pays d'origine" name="countryOfOrigin" placeholder="Inde" />
            <SelectField label="Statut de fabrication" name="manufacturingStatus" options={optionsFromMap(MANUFACTURING_STATUS)} defaultValue="IMPORTATION" />
            <SelectField label="Priorité" name="priority" options={optionsFromMap(PRIORITY)} defaultValue="MEDIUM" />
            <SelectField label="Statut initial" name="status" options={optionsFromMap(REGULATORY_STATUS)} defaultValue="PRE_SUBMISSION" />
            <SelectField label="Responsable" name="responsibleId" options={userOptions} placeholder="—" />
            <SelectField label="Assistante assignée" name="assistantId" options={userOptions} placeholder="—" />
            <TextField label="Date cible d'enregistrement" name="targetDate" type="date" className="sm:col-span-2" />
            <TextField label="Détenteur de DE" name="deHolder" placeholder="Titulaire de la décision d'enregistrement" className="sm:col-span-2" />
          </div>
          <TextAreaField label="Commentaires" name="comments" placeholder="Notes internes…" />

          <CtdALaCreation entrees={ctd} onChange={setCtd} />
          {ctdManquante && <p className="text-xs text-muted-foreground">La CTD initiale est obligatoire pour créer un dossier dans le suivi (au pipeline, elle peut venir plus tard).</p>}

          <DciDuplicateBanner dci={dci} check={doublon} onPartirDuProduit={partirDuProduit} />
          {/* L'accord de la personne, porté par le formulaire. Le serveur refuse sans lui : la
              garde vit là-bas, l'écran ne fait que ne pas proposer ce qui serait refusé. */}
          {doublon.acknowledged && <input type="hidden" name="confirmDuplicate" value="1" />}

          {state?.error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {state.error}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={submitting || doublon.blocking || ctdManquante} title={ctdManquante ? "Joignez la CTD initiale" : undefined}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Créer le dossier
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
