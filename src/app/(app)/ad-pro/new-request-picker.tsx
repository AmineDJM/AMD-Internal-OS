"use client";

import * as React from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Icon } from "@/components/ui/icon";
import { RecordForm } from "@/components/shared/create-record-button";
import { createSponsoring } from "@/modules/ad-pro/actions-sponsoring";
import { DemandeMaterielForm } from "@/modules/ad-pro/ecrans/demande-materiel-form";
import { createConsultingContract } from "@/lib/actions/consulting-actions";
import { createAdProOtherRequest } from "@/modules/ad-pro/actions-autres";
import type { AdProKind, KindSpec } from "@/modules/ad-pro/partage";
import {
  sponsoringCreateFields, consultingCreateFields, adProOtherCreateFields,
  toPeople, type AdProCreateData,
} from "@/modules/ad-pro/partage";
import { CongressRequestForm } from "../congress-international/congress-request-form";
import { CreateEventForm } from "../events/event-form";

export interface NewRequestPickerProps {
  /** Natures que cette personne a le droit de CRÉER — pas seulement de consulter. */
  kinds: KindSpec[];
  data: AdProCreateData;
}

/**
 * « NOUVELLE DEMANDE » — UNE SEULE PORTE, ET ON NE LA FRANCHIT PAS.
 *
 * On ne demande pas « quel module ? » mais « qu'est-ce que vous voulez faire ? », et chaque
 * réponse est écrite dans les mots du demandeur : « envoyer un praticien à un congrès à
 * l'étranger », pas « prise en charge internationale ». La différence n'est pas cosmétique — la
 * première phrase se reconnaît, la seconde se traduit.
 *
 * Le choix fait, le formulaire s'ouvre **ici**, dans le même panneau. Emmener vers l'écran de la
 * nature — son titre, sa description, sa barre d'onglets — c'était rendre au demandeur le
 * découpage interne qu'on venait précisément de lui épargner : il choisissait « congrès à
 * l'étranger » et se retrouvait sur « Prises en charge Internationales », à se demander s'il
 * était au bon endroit. Il ne quitte plus Ad & Pro.
 *
 * Les CHAMPS, eux, restent ceux de la nature : un congrès international a des billets et des
 * visas qu'un sponsoring n'a pas. C'est le contenant qui est commun, pas le contenu — et chaque
 * formulaire est le même objet que celui de son écran d'origine (`RecordForm`,
 * `CongressRequestForm`, `CreateEventForm`), jamais une copie qui divergerait au premier champ
 * ajouté.
 */
export function NewRequestPicker({ kinds, data }: NewRequestPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<AdProKind | null>(null);

  const people = React.useMemo(() => toPeople(data.users), [data.users]);
  // LES RÉFÉRENTIELS, ÉCRITS UNE FOIS : quatre formulaires les reçoivent, et les recopier ici
  // quatre fois serait quatre chances d'en oublier un (§118.5).
  const referentiels = React.useMemo(() => ({
    products: data.products, specialties: data.specialties, specialtiesHeritees: data.specialtiesHeritees,
    businessUnits: data.businessUnits, businessUnitDeduite: data.businessUnitDeduite,
  }), [data.products, data.specialties, data.specialtiesHeritees, data.businessUnits, data.businessUnitDeduite]);
  const spec = kind ? kinds.find((k) => k.kind === kind) : undefined;

  if (kinds.length === 0) return null;

  // Fermer remet au choix : rouvrir « Nouvelle demande » ne doit pas ramener le formulaire à
  // demi rempli de la fois d'avant.
  const close = () => { setOpen(false); setKind(null); };
  const back = () => setKind(null);

  // Depuis le panneau commun, « Annuler » ne ferme pas : il ramène à la liste des natures. C'est
  // le geste attendu quand on s'est trompé de nature — refermer obligerait à tout reprendre.
  const nav = { onDone: close, onCancel: back, cancelLabel: "Annuler" };

  return (
    <>
      <Button onClick={() => { setKind(null); setOpen(true); }}><Plus className="h-4 w-4" /> Nouvelle demande</Button>
      <Sheet
        open={open}
        onClose={close}
        title={spec ? spec.label : "Nouvelle demande Ad & Pro"}
        // La phrase d'aide de la nature sert à CHOISIR (dans la liste) ; une fois choisie, le titre suffit (Direction, 07/10).
        description={spec ? undefined : "Que souhaitez-vous faire ?"}
        width="lg"
      >
        {!spec ? (
          <ul className="space-y-2">
            {kinds.map((k) => (
              <li key={k.kind}>
                <button
                  type="button"
                  onClick={() => setKind(k.kind)}
                  className="flex w-full min-w-0 items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                >
                  <Icon name={k.icon} className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{k.label}</span>
                    <span className="block text-xs text-muted-foreground">{k.hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            <button
              type="button"
              onClick={back}
              className="inline-flex min-h-9 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-0"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Toutes les natures
            </button>

            {spec.kind === "SPONSORING" && (
              <RecordForm
                {...nav}
                action={createSponsoring}
                redirectBase="/sponsoring"
                fields={sponsoringCreateFields({
                  products: data.products, doctors: data.doctors, businessUnits: data.businessUnits,
                  businessUnitDeduite: data.businessUnitDeduite,
                  specialties: data.specialties, specialtiesHeritees: data.specialtiesHeritees,
                })}
              />
            )}
            {spec.kind === "CONGRESS_INTERNATIONAL" && (
              <CongressRequestForm {...nav} doctors={data.doctors} users={data.users} {...referentiels} />
            )}
            {spec.kind === "CONGRESS_NATIONAL" && (
              <CongressRequestForm {...nav} national doctors={data.doctors} users={data.users} {...referentiels} />
            )}
            {spec.kind === "EVENT" && (
              <CreateEventForm
                {...nav}
                responsibles={people}
                referentiels={{
                  doctors: data.doctors, products: data.products,
                  specialties: data.specialties, specialtiesHeritees: data.specialtiesHeritees,
                  businessUnits: data.businessUnits, businessUnitDeduite: data.businessUnitDeduite,
                }}
              />
            )}
            {spec.kind === "PROMO_MATERIAL" && (
              // LES LIGNES DÈS LA CRÉATION (§118.171) : un formulaire à champs fixes ne sait pas dire
              // « autant de lignes que je veux ». Plus de gamme, de budget, d'assistante ni d'entité.
              <DemandeMaterielForm {...nav} catalogue={data.catalogueMateriel.catalogue} produits={data.catalogueMateriel.produits} />
            )}
            {spec.kind === "CONSULTING" && (
              <RecordForm
                {...nav}
                action={createConsultingContract}
                redirectBase="/consulting"
                fields={consultingCreateFields({
                  companies: data.companies, businessUnits: data.businessUnits,
                  businessUnitDeduite: data.businessUnitDeduite,
                  products: data.products, doctors: data.doctors,
                })}
              />
            )}
            {spec.kind === "OTHER" && (
              <RecordForm
                {...nav}
                action={createAdProOtherRequest}
                redirectBase="/ad-pro/autres"
                fields={adProOtherCreateFields({
                  companies: data.companies, businessUnits: data.businessUnits,
                  businessUnitDeduite: data.businessUnitDeduite,
                  products: data.products, doctors: data.doctors,
                })}
              />
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}
