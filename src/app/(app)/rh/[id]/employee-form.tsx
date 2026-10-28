"use client";

import { phraseIaNonConfiguree, courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import * as React from "react";
import { Loader2, Check, Wand2, Sparkles } from "lucide-react";
import { updateEmployee, analyzeEmployeeContract } from "@/lib/actions/hr-actions";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import { CONTRACT_TYPE } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

type Option = { value: string; label: string };

export interface EmployeeFormValues {
  id: string;
  fullName: string;
  position: string;
  department: string;
  departmentId: string;
  contractType: string;
  baseSalary: string;
  retSS9: string;
  retSS35: string;
  tfp: string;
  retIrg: string;
  expenseRefund: string;
  netToPay: string;
  grossSalary: string;
  employerCost: string;
  leaveBalanceDays: string;
  hireDate: string;
  contractStart: string;
  contractEnd: string;
  trialStart: string;
  trialEnd: string;
  trialRenewable: boolean;
  trialRenewed: boolean;
  trialRenewalStart: string;
  trialRenewalEnd: string;
  birthDate: string;
  email: string;
  phone: string;
  iban: string;
  nationalId: string;
  cnasNumber: string;
  address: string;
  companyId: string;
  managerId: string;
  userId: string;
  isActive: boolean;
  /**
   * LE COFFRE (refonte V2-E) : les données sensibles que la politique ne vous ouvre pas, par leur masque.
   * Le champ est alors affiché en lecture seule et n'est PAS envoyé : l'action garde la valeur en place.
   */
  masques?: Partial<Record<"iban" | "nationalId" | "baseSalary" | "grossSalary" | "netToPay" | "employerCost", string>>;
}

interface Props {
  employee: EmployeeFormValues;
  managerOptions: Option[];
  departmentOptions: Option[];
  userOptions: Option[];
  companyOptions: Option[];
  aiConfigured: boolean;
  /** Le nom de la clé manquante, lu côté serveur (§118.128). */
  cleIa?: string | null;
}

// Clavier adapté au téléphone : pavé décimal pour les montants, numérique pour les identifiants.
// `autoComplete="off"` sur les données d'un TIERS : le navigateur proposerait sinon celles de l'utilisateur.
function TextInput({ name, label, type = "text", defaultValue, full, required, inputMode, autoComplete, masque }: {
  name: string; label: string; type?: string; defaultValue?: string; full?: boolean; required?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; autoComplete?: string;
  /** Donnée du coffre non ouverte à cette personne : le masque, en lecture seule, sans `name` (rien n'est envoyé). */
  masque?: string;
}) {
  if (masque) {
    return (
      <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
        <Label htmlFor={name}>{label}</Label>
        <Input id={name} value={masque} readOnly disabled title="Donnée sensible : lue par les RH (salaires, NIN) ou les Finances (RIB / IBAN). Elle reste inchangée à l'enregistrement." />
      </div>
    );
  }
  return (
    <div className={full ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
      <Label htmlFor={name}>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</Label>
      <Input
        id={name} name={name} type={type} defaultValue={defaultValue} required={required} step={type === "number" ? "any" : undefined}
        inputMode={inputMode ?? (type === "number" ? "decimal" : undefined)} autoComplete={autoComplete}
      />
    </div>
  );
}

function SelectInput({ name, label, defaultValue, options, placeholder }: { name: string; label: string; defaultValue?: string; options: Option[]; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Select id={name} name={name} defaultValue={defaultValue}>
        <option value="">{placeholder ?? "—"}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </div>
  );
}

export function EmployeeForm({ employee, managerOptions, departmentOptions, userOptions, companyOptions, aiConfigured, cleIa = null }: Props) {
  const { rafraichir } = useRafraichir();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  // CE QUE L'ENREGISTREMENT A DIT — un refus, ou ce qu'il a entraîné (le compte qui suit la fiche,
  // §118.184 — S13). Le formulaire affichait « Enregistré » quoi que l'action réponde : un refus se lisait
  // comme un succès (le faux succès d'écran de §118.153d).
  const [retour, setRetour] = React.useState<{ ok: boolean; text: string } | null>(null);

  // Pré-remplissage IA depuis un contrat : les valeurs extraites priment sur les valeurs
  // actuelles ; le RH relit et corrige avant d'enregistrer. Re-montage des champs par `key`.
  const [prefill, setPrefill] = React.useState<Record<string, string>>({});
  const [prefillVersion, setPrefillVersion] = React.useState(0);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [analyzeMsg, setAnalyzeMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const contractOptions = Object.entries(CONTRACT_TYPE).map(([value, label]) => ({ value, label }));
  const v = { ...employee, ...prefill } as unknown as Record<string, string>;

  async function runAnalyze() {
    const f = fileRef.current?.files?.[0];
    if (!f) { setAnalyzeMsg({ ok: false, text: "Choisissez d'abord le contrat (PDF ou image)." }); return; }
    setAnalyzing(true); setAnalyzeMsg(null);
    const fd = new FormData(); fd.set("file", f);
    let r: Awaited<ReturnType<typeof analyzeEmployeeContract>>;
    try {
      r = await analyzeEmployeeContract(fd);
    } catch {
      setAnalyzeMsg({ ok: false, text: actionFailureMessage("THROWN") });
      return;
    } finally {
      setAnalyzing(false);
    }
    if (!r.ok) { setAnalyzeMsg({ ok: false, text: r.error ?? "Analyse impossible." }); return; }
    setPrefill((p) => ({ ...p, ...(r.values ?? {}) }));
    setPrefillVersion((n) => n + 1);
    setAnalyzeMsg({ ok: true, text: `${Object.keys(r.values ?? {}).length} champ(s) mis à jour — vérifiez et enregistrez.` });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <p className="flex items-center gap-1.5 text-sm font-medium text-primary"><Wand2 className="h-4 w-4" /> Compléter depuis un contrat de travail (IA)</p>
        <p className="text-xs text-muted-foreground">Téléversez le contrat (PDF ou image) : l&apos;OCR Mistral + l&apos;IA extraient et pré-remplissent les champs. Tout reste modifiable avant enregistrement.</p>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" disabled={!aiConfigured || analyzing}
            className="w-full min-w-0 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:font-medium sm:w-auto" />
          <Button type="button" size="sm" className="w-full sm:w-auto" onClick={runAnalyze} disabled={!aiConfigured || analyzing} title={aiConfigured ? undefined : courtIaNonConfiguree(cleIa)}>
            {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Analyser le contrat
          </Button>
        </div>
        {!aiConfigured && <p className="text-xs text-amber-700">{phraseIaNonConfiguree(cleIa, "l'analyse automatique d'un contrat de travail")}</p>}
        {analyzeMsg && <p className={cn("text-xs", analyzeMsg.ok ? "text-success" : "text-destructive")}>{analyzeMsg.text}</p>}
      </div>

      <form
        action={async (fd) => {
          setSaving(true);
          setRetour(null);
          try {
            const r = await updateEmployee(fd);
            setSaving(false);
            if (!r.ok) {
              setRetour({ ok: false, text: r.error ?? "Enregistrement refusé." });
              return;
            }
            if (r.message) setRetour({ ok: true, text: r.message });
            setSaved(true);
            rafraichir();
            setTimeout(() => setSaved(false), 1500);
          } catch {
            setRetour({ ok: false, text: actionFailureMessage("THROWN") });
          } finally {
            setSaving(false);
          }
        }}
        className="space-y-4"
      >
        <input type="hidden" name="id" value={employee.id} />
        <div key={prefillVersion} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextInput name="fullName" label="Nom complet" defaultValue={v.fullName} full required autoComplete="off" />
          <TextInput name="position" label="Poste" defaultValue={v.position} />
          <SelectInput name="departmentId" label="Département" defaultValue={v.departmentId} options={departmentOptions} placeholder="— Non affecté —" />
          <SelectInput name="companyId" label="Entité" defaultValue={v.companyId} options={companyOptions} placeholder="— Entité —" />
          <SelectInput name="contractType" label="Type de contrat" defaultValue={v.contractType} options={contractOptions} />
          <TextInput name="leaveBalanceDays" label="Solde congés (jours)" type="number" defaultValue={v.leaveBalanceDays} />

          {/* Rémunération (bulletin). Côté salarié : brut, Ret SS 35 % et TFP restent invisibles. */}
          <p className="mt-1 text-xs sm:col-span-2 font-semibold uppercase tracking-wide text-muted-foreground">Rémunération (bulletin de paie)</p>
          <TextInput name="baseSalary" label="Salaire de base (DZD)" type="number" defaultValue={v.baseSalary} masque={employee.masques?.baseSalary} />
          <TextInput name="grossSalary" label="Salaire brut (confidentiel)" type="number" defaultValue={v.grossSalary} masque={employee.masques?.grossSalary} />
          {/* CE QUE LE SALARIÉ COÛTE VRAIMENT — brut + charges patronales. C'est ce montant, et
              non le brut, qui fait la masse salariale et qu'on impute au budget. */}
          <TextInput name="employerCost" label="Coût employeur (confidentiel)" type="number" defaultValue={v.employerCost} masque={employee.masques?.employerCost} />
          <TextInput name="retSS9" label="Ret. SS 9 %" type="number" defaultValue={v.retSS9} />
          <TextInput name="retSS35" label="Ret. SS 35 % (confidentiel)" type="number" defaultValue={v.retSS35} />
          <TextInput name="tfp" label="TFP — taxe formation prof. (confidentiel)" type="number" defaultValue={v.tfp} />
          <TextInput name="retIrg" label="Ret. IRG" type="number" defaultValue={v.retIrg} />
          <TextInput name="expenseRefund" label="Remb. frais" type="number" defaultValue={v.expenseRefund} />
          <TextInput name="netToPay" label="Net à payer" type="number" defaultValue={v.netToPay} masque={employee.masques?.netToPay} />
          <TextInput name="hireDate" label="Date d'embauche" type="date" defaultValue={v.hireDate} />
          <TextInput name="contractStart" label="Début de contrat" type="date" defaultValue={v.contractStart} />
          <TextInput name="contractEnd" label="Fin de contrat" type="date" defaultValue={v.contractEnd} />
          <TextInput name="trialStart" label="Période d'essai — début" type="date" defaultValue={v.trialStart} />
          <TextInput name="trialEnd" label="Période d'essai — fin" type="date" defaultValue={v.trialEnd} />
          <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-1">
            <input type="checkbox" name="trialRenewable" defaultChecked={employee.trialRenewable} className="h-4 w-4 rounded border-border accent-primary" />
            Période d'essai renouvelable
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-1">
            <input type="checkbox" name="trialRenewed" defaultChecked={employee.trialRenewed} className="h-4 w-4 rounded border-border accent-primary" />
            Renouvelée (2ᵉ période)
          </label>
          <TextInput name="trialRenewalStart" label="2ᵉ période — début" type="date" defaultValue={v.trialRenewalStart} />
          <TextInput name="trialRenewalEnd" label="2ᵉ période — fin" type="date" defaultValue={v.trialRenewalEnd} />
          <TextInput name="birthDate" label="Date de naissance" type="date" defaultValue={v.birthDate} />
          {/* Clavier e-mail SANS la validation du navigateur : une adresse déjà mal saisie en base bloquerait tout l'enregistrement. */}
          <TextInput name="email" label="Email" inputMode="email" defaultValue={v.email} autoComplete="off" />
          <TextInput name="phone" label="Téléphone" type="tel" defaultValue={v.phone} autoComplete="off" />
          <TextInput name="iban" label="RIB / IBAN" defaultValue={v.iban} autoComplete="off" masque={employee.masques?.iban} />
          <TextInput name="nationalId" label="NIN" defaultValue={v.nationalId} inputMode="numeric" autoComplete="off" masque={employee.masques?.nationalId} />
          <TextInput name="cnasNumber" label="N° CNAS" defaultValue={v.cnasNumber} inputMode="numeric" autoComplete="off" />
          <TextInput name="address" label="Adresse" defaultValue={v.address} full autoComplete="off" />
          <SelectInput name="managerId" label="Manager (N+1)" defaultValue={v.managerId} options={managerOptions} />
          <SelectInput name="userId" label="Compte applicatif lié" defaultValue={v.userId} options={userOptions} placeholder="Aucun" />
          <label className="flex min-h-10 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="isActive" defaultChecked={employee.isActive} className="h-4 w-4 rounded border-input" />
            Employé actif
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {retour && <p role={retour.ok ? "status" : "alert"} className={cn("text-xs", retour.ok ? "text-muted-foreground" : "text-destructive")}>{retour.text}</p>}
          <Button type="submit" className="w-full sm:w-auto" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
            {saved ? "Enregistré" : "Enregistrer les modifications"}
          </Button>
        </div>
      </form>
    </div>
  );
}
