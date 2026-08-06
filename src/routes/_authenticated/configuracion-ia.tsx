import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Eye, EyeOff, Lightbulb, Loader2, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useActiveCompany } from "@/lib/active-company";
import { EmptyCompany, useCompanies } from "@/components/app-shell";
import { testAiConnection } from "@/lib/ai-config.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export const Route = createFileRoute("/_authenticated/configuracion-ia")({
  head: () => ({
    meta: [
      { title: "Configuración IA · Motor de causación" },
      { name: "description", content: "Configura el proveedor, el modelo y las indicaciones de extracción y mapeo contable del motor de IA." },
      { property: "og:title", content: "Configuración IA" },
      { property: "og:description", content: "Proveedor, modelo, clave API e indicaciones del motor de extracción y mapeo contable." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ConfiguracionIA,
});

const PROVIDERS = [
  { value: "lovable", label: "IA incluida (sin clave)", models: ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "google/gemini-3.6-flash"] },
  { value: "openai", label: "OpenAI", models: ["gpt-4.1", "gpt-4o", "gpt-4o-mini"] },
  { value: "google", label: "Géminis de Google", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
  { value: "anthropic", label: "Anthropic", models: ["claude-sonnet-4-20250514"] },
];

const DEFAULT_EXTRACTION = `Extrae de la factura: prefijo, número, fechas, NIT y datos del proveedor, CUFE, forma y medio de pago, moneda, y el detalle de cada línea (código, descripción, cantidad, valor unitario, descuento, IVA, impoconsumo y total).
No inventes valores: si un dato no aparece, déjalo vacío.`;

const DEFAULT_MAPPING = `Asigna a cada línea la cuenta del PUC de la empresa según la descripción y el proveedor.
Aplica IVA descontable cuando corresponda y calcula las retenciones (Retefuente, ReteIVA, ReteICA) según el tipo de proveedor.
Prioriza las reglas aprendidas del proveedor antes que las reglas generales.`;

const TIPS = [
  "El prompt de extracción define QUÉ datos saca. El mapeo define A QUÉ CUENTA se asigna. Son independientes.",
  "Puedes añadir instrucciones para retenciones (ICA, IVA, Reteiva, Retefuente) como líneas adicionales.",
  "Si cambias de proveedor, las indicaciones funcionan igual. Solo cambia la clave API y el modelo.",
];

function ConfiguracionIA() {
  const companyId = useActiveCompany();
  const qc = useQueryClient();
  const { data: companies, isLoading: loadingCompanies } = useCompanies();

  const [provider, setProvider] = useState("lovable");
  const [model, setModel] = useState("openai/gpt-5.6-sol");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [extraction, setExtraction] = useState(DEFAULT_EXTRACTION);
  const [mapping, setMapping] = useState(DEFAULT_MAPPING);
  const [hiddenTips, setHiddenTips] = useState<number[]>([]);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: settings } = useQuery({
    queryKey: ["ai-settings", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("ai_settings").select("*").eq("company_id", companyId!).maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!settings) return;
    setProvider(settings.provider);
    setModel(settings.model);
    setApiKey(settings.api_key ?? "");
    setExtraction(settings.extraction_prompt || DEFAULT_EXTRACTION);
    setMapping(settings.mapping_prompt || DEFAULT_MAPPING);
  }, [settings]);

  const providerDef = PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0]!;

  async function save() {
    if (!companyId) return;
    setSaving(true);
    const { error } = await supabase.from("ai_settings").upsert(
      {
        company_id: companyId,
        provider,
        model,
        api_key: provider === "lovable" ? null : apiKey || null,
        extraction_prompt: extraction,
        mapping_prompt: mapping,
      },
      { onConflict: "company_id" },
    );
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Configuración de IA guardada");
    qc.invalidateQueries({ queryKey: ["ai-settings", companyId] });
  }

  async function probar() {
    setTesting(true);
    try {
      const res = await testAiConnection({ data: { provider, model, apiKey } });
      if (res.ok) toast.success(`Conexión correcta (${res.ms} ms)`);
      else toast.error(`Error ${res.status}: ${res.detail}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No fue posible probar la conexión");
    } finally {
      setTesting(false);
    }
  }

  if (!loadingCompanies && (companies ?? []).length === 0) return <EmptyCompany />;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Configuración IA</h1>
        <p className="text-sm text-muted-foreground">Motor de extracción y mapeo contable</p>
      </header>

      <Collapsible className="rounded-lg border border-border bg-card">
        <CollapsibleTrigger className="group flex w-full items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          ¿Cómo funciona esta sección?
          <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 border-t border-border px-4 py-3 text-sm text-muted-foreground">
          <p>1. Elige el proveedor y el modelo que leerá tus facturas. Con la IA incluida no necesitas clave API.</p>
          <p>2. Ajusta la indicación de extracción para definir qué datos se leen del documento.</p>
          <p>3. Ajusta la indicación de mapeo contable para definir cómo se asignan cuentas, IVA y retenciones.</p>
          <p>4. Prueba la conexión y guarda: la causación usará esta configuración para la empresa activa.</p>
        </CollapsibleContent>
      </Collapsible>

      <div className="space-y-2">
        {TIPS.map((tip, i) =>
          hiddenTips.includes(i) ? null : (
            <div key={i} className="flex items-start gap-3 rounded-md border-l-4 border-l-amber-500 border border-border bg-card px-4 py-3">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-amber-500" />
              <p className="flex-1 text-sm text-muted-foreground">{tip}</p>
              <button onClick={() => setHiddenTips((h) => [...h, i])} className="text-muted-foreground hover:text-foreground" aria-label="Ocultar consejo">
                <X className="size-4" />
              </button>
            </div>
          ),
        )}
      </div>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Proveedor y modelo</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Proveedor</Label>
            <Select
              value={provider}
              onValueChange={(v) => {
                setProvider(v);
                const def = PROVIDERS.find((p) => p.value === v);
                if (def) setModel(def.models[0]!);
              }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Modelo</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} list="ai-models" className="font-mono text-sm" />
            <datalist id="ai-models">
              {providerDef.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Clave API</Label>
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider === "lovable" ? "No requiere clave" : "Ingresa tu API Key"}
                disabled={provider === "lovable"}
                autoComplete="off"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showKey ? "Ocultar clave" : "Mostrar clave"}
              >
                {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>
        </div>
        <Button variant="outline" className="mt-4" onClick={probar} disabled={testing}>
          {testing ? <Loader2 className="size-4 animate-spin" /> : null} Probar conexión
        </Button>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Indicación de extracción</h2>
        <p className="mt-1 text-sm text-muted-foreground">Define qué datos se leen de la factura.</p>
        <Textarea className="mt-3 min-h-40 font-mono text-sm" value={extraction} onChange={(e) => setExtraction(e.target.value)} />
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Indicación de mapeo contable</h2>
        <p className="mt-1 text-sm text-muted-foreground">Define a qué cuentas, IVA y retenciones se asigna cada línea.</p>
        <Textarea className="mt-3 min-h-40 font-mono text-sm" value={mapping} onChange={(e) => setMapping(e.target.value)} />
      </section>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => { setExtraction(DEFAULT_EXTRACTION); setMapping(DEFAULT_MAPPING); }}>
          Restaurar indicaciones
        </Button>
        <Button onClick={save} disabled={saving || !companyId}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null} Guardar configuración
        </Button>
      </div>
    </div>
  );
}
