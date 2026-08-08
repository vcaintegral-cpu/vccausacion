export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      accounting_rules: {
        Row: {
          account_code: string
          account_name: string | null
          company_id: string
          created_at: string
          id: string
          match_type: string
          match_value: string
          priority: number
          source: string
        }
        Insert: {
          account_code: string
          account_name?: string | null
          company_id: string
          created_at?: string
          id?: string
          match_type?: string
          match_value: string
          priority?: number
          source?: string
        }
        Update: {
          account_code?: string
          account_name?: string | null
          company_id?: string
          created_at?: string
          id?: string
          match_type?: string
          match_value?: string
          priority?: number
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounting_rules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_settings: {
        Row: {
          api_key: string | null
          company_id: string
          created_at: string
          extraction_prompt: string
          id: string
          mapping_prompt: string
          model: string
          provider: string
          updated_at: string
        }
        Insert: {
          api_key?: string | null
          company_id: string
          created_at?: string
          extraction_prompt?: string
          id?: string
          mapping_prompt?: string
          model?: string
          provider?: string
          updated_at?: string
        }
        Update: {
          api_key?: string | null
          company_id?: string
          created_at?: string
          extraction_prompt?: string
          id?: string
          mapping_prompt?: string
          model?: string
          provider?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          auto_learning: boolean
          created_at: string
          created_by: string
          currency: string
          id: string
          name: string
          nit: string | null
        }
        Insert: {
          auto_learning?: boolean
          created_at?: string
          created_by?: string
          currency?: string
          id?: string
          name: string
          nit?: string | null
        }
        Update: {
          auto_learning?: boolean
          created_at?: string
          created_by?: string
          currency?: string
          id?: string
          name?: string
          nit?: string | null
        }
        Relationships: []
      }
      company_members: {
        Row: {
          company_id: string
          created_at: string
          id: string
          role: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          role?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_members_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_centers: {
        Row: {
          code: string
          company_id: string
          created_at: string
          id: string
          name: string
          source: string
        }
        Insert: {
          code: string
          company_id: string
          created_at?: string
          id?: string
          name: string
          source?: string
        }
        Update: {
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          name?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_centers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_lines: {
        Row: {
          account_code: string | null
          account_name: string | null
          code: string | null
          company_id: string
          description: string | null
          discount: number
          id: string
          impoconsumo: number
          invoice_id: string
          item_type: string
          iva: number
          position: number
          quantity: number
          retention: number
          total: number
          unit_value: number
        }
        Insert: {
          account_code?: string | null
          account_name?: string | null
          code?: string | null
          company_id: string
          description?: string | null
          discount?: number
          id?: string
          impoconsumo?: number
          invoice_id: string
          item_type?: string
          iva?: number
          position?: number
          quantity?: number
          retention?: number
          total?: number
          unit_value?: number
        }
        Update: {
          account_code?: string | null
          account_name?: string | null
          code?: string | null
          company_id?: string
          description?: string | null
          discount?: number
          id?: string
          impoconsumo?: number
          invoice_id?: string
          item_type?: string
          iva?: number
          position?: number
          quantity?: number
          retention?: number
          total?: number
          unit_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          buyer_name: string | null
          buyer_nit: string | null
          company_id: string
          cost_center: string | null
          created_at: string
          created_by: string
          cufe: string | null
          currency: string | null
          dian_status: string | null
          discount: number
          due_date: string | null
          file_name: string | null
          file_path: string | null
          id: string
          impoconsumo: number
          issue_date: string | null
          iva: number
          notes: string | null
          number: string | null
          payment_form: string | null
          payment_method: string | null
          prefix: string | null
          provider_address: string | null
          provider_city: string | null
          provider_email: string | null
          provider_name: string | null
          provider_nit: string | null
          provider_phone: string | null
          raw_extraction: Json | null
          retefuente: number
          reteica: number
          reteiva: number
          siigo_document_url: string | null
          siigo_error: string | null
          siigo_id: string | null
          siigo_last_attempt_at: string | null
          siigo_number: string | null
          siigo_status: string
          siigo_synced_at: string | null
          siigo_synced_by: string | null
          status: string
          subtotal: number
          total: number
          updated_at: string
        }
        Insert: {
          buyer_name?: string | null
          buyer_nit?: string | null
          company_id: string
          cost_center?: string | null
          created_at?: string
          created_by?: string
          cufe?: string | null
          currency?: string | null
          dian_status?: string | null
          discount?: number
          due_date?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          impoconsumo?: number
          issue_date?: string | null
          iva?: number
          notes?: string | null
          number?: string | null
          payment_form?: string | null
          payment_method?: string | null
          prefix?: string | null
          provider_address?: string | null
          provider_city?: string | null
          provider_email?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          provider_phone?: string | null
          raw_extraction?: Json | null
          retefuente?: number
          reteica?: number
          reteiva?: number
          siigo_document_url?: string | null
          siigo_error?: string | null
          siigo_id?: string | null
          siigo_last_attempt_at?: string | null
          siigo_number?: string | null
          siigo_status?: string
          siigo_synced_at?: string | null
          siigo_synced_by?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Update: {
          buyer_name?: string | null
          buyer_nit?: string | null
          company_id?: string
          cost_center?: string | null
          created_at?: string
          created_by?: string
          cufe?: string | null
          currency?: string | null
          dian_status?: string | null
          discount?: number
          due_date?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          impoconsumo?: number
          issue_date?: string | null
          iva?: number
          notes?: string | null
          number?: string | null
          payment_form?: string | null
          payment_method?: string | null
          prefix?: string | null
          provider_address?: string | null
          provider_city?: string | null
          provider_email?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          provider_phone?: string | null
          raw_extraction?: Json | null
          retefuente?: number
          reteica?: number
          reteiva?: number
          siigo_document_url?: string | null
          siigo_error?: string | null
          siigo_id?: string | null
          siigo_last_attempt_at?: string | null
          siigo_number?: string | null
          siigo_status?: string
          siigo_synced_at?: string | null
          siigo_synced_by?: string | null
          status?: string
          subtotal?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_lines: {
        Row: {
          account_code: string
          account_name: string | null
          company_id: string
          cost_center: string | null
          credit: number
          debit: number
          id: string
          invoice_id: string
          position: number
        }
        Insert: {
          account_code: string
          account_name?: string | null
          company_id: string
          cost_center?: string | null
          credit?: number
          debit?: number
          id?: string
          invoice_id: string
          position?: number
        }
        Update: {
          account_code?: string
          account_name?: string | null
          company_id?: string
          cost_center?: string | null
          credit?: number
          debit?: number
          id?: string
          invoice_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "journal_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      learning_events: {
        Row: {
          account_code: string
          company_id: string
          concept: string | null
          created_at: string
          created_by: string
          id: string
          provider_nit: string | null
        }
        Insert: {
          account_code: string
          company_id: string
          concept?: string | null
          created_at?: string
          created_by?: string
          id?: string
          provider_nit?: string | null
        }
        Update: {
          account_code?: string
          company_id?: string
          concept?: string | null
          created_at?: string
          created_by?: string
          id?: string
          provider_nit?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "learning_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      learning_rules: {
        Row: {
          account_code: string
          account_name: string | null
          active: boolean
          company_id: string
          concept: string | null
          cost_center: string | null
          created_at: string
          created_by: string
          id: string
          item_type: string
          iva: number
          last_used_at: string | null
          provider_name: string | null
          provider_nit: string | null
          retentions: string | null
          source: string
          taxes: string | null
          times_used: number
        }
        Insert: {
          account_code: string
          account_name?: string | null
          active?: boolean
          company_id: string
          concept?: string | null
          cost_center?: string | null
          created_at?: string
          created_by?: string
          id?: string
          item_type?: string
          iva?: number
          last_used_at?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          retentions?: string | null
          source?: string
          taxes?: string | null
          times_used?: number
        }
        Update: {
          account_code?: string
          account_name?: string | null
          active?: boolean
          company_id?: string
          concept?: string | null
          cost_center?: string | null
          created_at?: string
          created_by?: string
          id?: string
          item_type?: string
          iva?: number
          last_used_at?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          retentions?: string | null
          source?: string
          taxes?: string | null
          times_used?: number
        }
        Relationships: [
          {
            foreignKeyName: "learning_rules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      product_categories: {
        Row: {
          account_code: string | null
          account_name: string | null
          active: boolean
          company_id: string
          created_at: string
          id: string
          kind: string
          name: string
          source: string
          updated_at: string
        }
        Insert: {
          account_code?: string | null
          account_name?: string | null
          active?: boolean
          company_id: string
          created_at?: string
          id?: string
          kind?: string
          name: string
          source?: string
          updated_at?: string
        }
        Update: {
          account_code?: string | null
          account_name?: string | null
          active?: boolean
          company_id?: string
          created_at?: string
          id?: string
          kind?: string
          name?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_categories_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          account_code: string | null
          account_name: string | null
          active: boolean
          category: string | null
          category_id: string | null
          code: string
          company_id: string
          created_at: string
          id: string
          kind: string
          name: string
          siigo_id: string | null
          source: string
          updated_at: string
        }
        Insert: {
          account_code?: string | null
          account_name?: string | null
          active?: boolean
          category?: string | null
          category_id?: string | null
          code: string
          company_id: string
          created_at?: string
          id?: string
          kind?: string
          name: string
          siigo_id?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          account_code?: string | null
          account_name?: string | null
          active?: boolean
          category?: string | null
          category_id?: string | null
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          kind?: string
          name?: string
          siigo_id?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "product_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string | null
          full_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      providers: {
        Row: {
          address: string | null
          city: string | null
          company_id: string
          created_at: string
          default_expense_account: string | null
          default_iva_account: string | null
          default_payable_account: string | null
          economic_activity: string | null
          email: string | null
          id: string
          name: string
          nit: string
          phone: string | null
          regime: string | null
        }
        Insert: {
          address?: string | null
          city?: string | null
          company_id: string
          created_at?: string
          default_expense_account?: string | null
          default_iva_account?: string | null
          default_payable_account?: string | null
          economic_activity?: string | null
          email?: string | null
          id?: string
          name: string
          nit: string
          phone?: string | null
          regime?: string | null
        }
        Update: {
          address?: string | null
          city?: string | null
          company_id?: string
          created_at?: string
          default_expense_account?: string | null
          default_iva_account?: string | null
          default_payable_account?: string | null
          economic_activity?: string | null
          email?: string | null
          id?: string
          name?: string
          nit?: string
          phone?: string | null
          regime?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "providers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      puc_accounts: {
        Row: {
          active: boolean
          code: string
          company_id: string
          created_at: string
          id: string
          name: string
          nature: string
          source: string
        }
        Insert: {
          active?: boolean
          code: string
          company_id: string
          created_at?: string
          id?: string
          name: string
          nature?: string
          source?: string
        }
        Update: {
          active?: boolean
          code?: string
          company_id?: string
          created_at?: string
          id?: string
          name?: string
          nature?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "puc_accounts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      siigo_credentials: {
        Row: {
          access_key: string
          id: string
          partner_id: string | null
          updated_at: string
          username: string
        }
        Insert: {
          access_key: string
          id?: string
          partner_id?: string | null
          updated_at?: string
          username: string
        }
        Update: {
          access_key?: string
          id?: string
          partner_id?: string | null
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      tax_rates: {
        Row: {
          account_code: string | null
          active: boolean
          company_id: string
          created_at: string
          id: string
          kind: string
          min_base: number
          name: string
          rate: number
          siigo_id: string | null
          siigo_name: string | null
          source: string
        }
        Insert: {
          account_code?: string | null
          active?: boolean
          company_id: string
          created_at?: string
          id?: string
          kind: string
          min_base?: number
          name: string
          rate?: number
          siigo_id?: string | null
          siigo_name?: string | null
          source?: string
        }
        Update: {
          account_code?: string | null
          active?: boolean
          company_id?: string
          created_at?: string
          id?: string
          kind?: string
          min_base?: number
          name?: string
          rate?: number
          siigo_id?: string | null
          siigo_name?: string | null
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "tax_rates_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      is_company_member: { Args: { _company_id: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
