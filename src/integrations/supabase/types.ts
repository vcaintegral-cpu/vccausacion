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
      account_resolutions: {
        Row: {
          company_id: string
          created_at: string
          created_by: string
          id: string
          invoice_id: string | null
          reason: string
          siigo_code: string | null
          siigo_id: string | null
          suggested_code: string
          used_code: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string
          id?: string
          invoice_id?: string | null
          reason: string
          siigo_code?: string | null
          siigo_id?: string | null
          suggested_code: string
          used_code?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string
          id?: string
          invoice_id?: string | null
          reason?: string
          siigo_code?: string | null
          siigo_id?: string | null
          suggested_code?: string
          used_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_resolutions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_resolutions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      accounting_history: {
        Row: {
          account_code: string | null
          account_name: string | null
          branch: string | null
          company_id: string
          cost_center: string | null
          created_at: string
          credit: number | null
          credit_text: string | null
          debit: number | null
          debit_text: string | null
          description: string | null
          detail: string | null
          entry_date_text: string | null
          excel_row: number
          file_name: string
          id: string
          imported_at: string
          imported_by: string
          original_row_data: Json
          period: string | null
          provider_name: string | null
          provider_nit: string | null
          sequence: string | null
          voucher: string | null
        }
        Insert: {
          account_code?: string | null
          account_name?: string | null
          branch?: string | null
          company_id: string
          cost_center?: string | null
          created_at?: string
          credit?: number | null
          credit_text?: string | null
          debit?: number | null
          debit_text?: string | null
          description?: string | null
          detail?: string | null
          entry_date_text?: string | null
          excel_row: number
          file_name: string
          id?: string
          imported_at?: string
          imported_by: string
          original_row_data?: Json
          period?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          sequence?: string | null
          voucher?: string | null
        }
        Update: {
          account_code?: string | null
          account_name?: string | null
          branch?: string | null
          company_id?: string
          cost_center?: string | null
          created_at?: string
          credit?: number | null
          credit_text?: string | null
          debit?: number | null
          debit_text?: string | null
          description?: string | null
          detail?: string | null
          entry_date_text?: string | null
          excel_row?: number
          file_name?: string
          id?: string
          imported_at?: string
          imported_by?: string
          original_row_data?: Json
          period?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          sequence?: string | null
          voucher?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accounting_history_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
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
      bulk_upload_items: {
        Row: {
          attempts: number
          buyer_name: string | null
          buyer_nit: string | null
          company_id: string
          company_validation: string | null
          content_status: string | null
          created_at: string
          download_status: string | null
          error_message: string | null
          extracted_text: string | null
          file_name: string
          fingerprint: string | null
          id: string
          invoice_id: string | null
          invoice_number: string | null
          invoice_total: number | null
          issue_date: string | null
          mime_type: string | null
          needs_review: boolean
          position: number
          provider_name: string | null
          provider_nit: string | null
          read_status: string | null
          retryable: boolean
          score: number | null
          size_bytes: number
          stage: string | null
          status: string
          storage_bucket: string
          storage_path: string | null
          stored_size_bytes: number | null
          updated_at: string
          upload_id: string
          user_message: string | null
        }
        Insert: {
          attempts?: number
          buyer_name?: string | null
          buyer_nit?: string | null
          company_id: string
          company_validation?: string | null
          content_status?: string | null
          created_at?: string
          download_status?: string | null
          error_message?: string | null
          extracted_text?: string | null
          file_name: string
          fingerprint?: string | null
          id?: string
          invoice_id?: string | null
          invoice_number?: string | null
          invoice_total?: number | null
          issue_date?: string | null
          mime_type?: string | null
          needs_review?: boolean
          position?: number
          provider_name?: string | null
          provider_nit?: string | null
          read_status?: string | null
          retryable?: boolean
          score?: number | null
          size_bytes?: number
          stage?: string | null
          status?: string
          storage_bucket?: string
          storage_path?: string | null
          stored_size_bytes?: number | null
          updated_at?: string
          upload_id: string
          user_message?: string | null
        }
        Update: {
          attempts?: number
          buyer_name?: string | null
          buyer_nit?: string | null
          company_id?: string
          company_validation?: string | null
          content_status?: string | null
          created_at?: string
          download_status?: string | null
          error_message?: string | null
          extracted_text?: string | null
          file_name?: string
          fingerprint?: string | null
          id?: string
          invoice_id?: string | null
          invoice_number?: string | null
          invoice_total?: number | null
          issue_date?: string | null
          mime_type?: string | null
          needs_review?: boolean
          position?: number
          provider_name?: string | null
          provider_nit?: string | null
          read_status?: string | null
          retryable?: boolean
          score?: number | null
          size_bytes?: number
          stage?: string | null
          status?: string
          storage_bucket?: string
          storage_path?: string | null
          stored_size_bytes?: number | null
          updated_at?: string
          upload_id?: string
          user_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bulk_upload_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_upload_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bulk_upload_items_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "bulk_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      bulk_uploads: {
        Row: {
          attempt_count: number
          company_id: string
          created_at: string
          created_by: string
          error_code: string | null
          error_count: number
          error_message: string | null
          error_stage: string | null
          file_name: string
          files_found: number
          finished_at: string | null
          id: string
          pdf_found: number
          processed_count: number
          size_bytes: number
          skipped_files: number
          started_at: string | null
          status: string
          storage_path: string | null
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          company_id: string
          created_at?: string
          created_by?: string
          error_code?: string | null
          error_count?: number
          error_message?: string | null
          error_stage?: string | null
          file_name: string
          files_found?: number
          finished_at?: string | null
          id?: string
          pdf_found?: number
          processed_count?: number
          size_bytes?: number
          skipped_files?: number
          started_at?: string | null
          status?: string
          storage_path?: string | null
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          company_id?: string
          created_at?: string
          created_by?: string
          error_code?: string | null
          error_count?: number
          error_message?: string | null
          error_stage?: string | null
          file_name?: string
          files_found?: number
          finished_at?: string | null
          id?: string
          pdf_found?: number
          processed_count?: number
          size_bytes?: number
          skipped_files?: number
          started_at?: string | null
          status?: string
          storage_path?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bulk_uploads_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
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
          default_payable_account: string | null
          id: string
          iva_account_costo: string | null
          iva_account_descontable: string | null
          iva_account_gasto: string | null
          iva_treatment_mode: string
          name: string
          nit: string | null
          uses_cost_centers: boolean | null
        }
        Insert: {
          auto_learning?: boolean
          created_at?: string
          created_by?: string
          currency?: string
          default_payable_account?: string | null
          id?: string
          iva_account_costo?: string | null
          iva_account_descontable?: string | null
          iva_account_gasto?: string | null
          iva_treatment_mode?: string
          name: string
          nit?: string | null
          uses_cost_centers?: boolean | null
        }
        Update: {
          auto_learning?: boolean
          created_at?: string
          created_by?: string
          currency?: string
          default_payable_account?: string | null
          id?: string
          iva_account_costo?: string | null
          iva_account_descontable?: string | null
          iva_account_gasto?: string | null
          iva_treatment_mode?: string
          name?: string
          nit?: string | null
          uses_cost_centers?: boolean | null
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
      draft_sync_events: {
        Row: {
          action: string
          affected: Json
          changes: Json
          company_id: string
          conflicts: Json
          created_at: string
          created_by: string | null
          event_key: string
          id: string
          invoice_count: number
          provider_name: string | null
          provider_nit: string | null
          result: string | null
          source_invoice_id: string | null
          source_label: string | null
          undone_at: string | null
          undone_by: string | null
        }
        Insert: {
          action?: string
          affected?: Json
          changes?: Json
          company_id: string
          conflicts?: Json
          created_at?: string
          created_by?: string | null
          event_key: string
          id?: string
          invoice_count?: number
          provider_name?: string | null
          provider_nit?: string | null
          result?: string | null
          source_invoice_id?: string | null
          source_label?: string | null
          undone_at?: string | null
          undone_by?: string | null
        }
        Update: {
          action?: string
          affected?: Json
          changes?: Json
          company_id?: string
          conflicts?: Json
          created_at?: string
          created_by?: string | null
          event_key?: string
          id?: string
          invoice_count?: number
          provider_name?: string | null
          provider_nit?: string | null
          result?: string | null
          source_invoice_id?: string | null
          source_label?: string | null
          undone_at?: string | null
          undone_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "draft_sync_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_sync_events_source_invoice_id_fkey"
            columns: ["source_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_events: {
        Row: {
          action: string
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          message: string | null
          siigo_status: string | null
          status: string
        }
        Insert: {
          action: string
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id: string
          message?: string | null
          siigo_status?: string | null
          status: string
        }
        Update: {
          action?: string
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string
          message?: string | null
          siigo_status?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_events_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_events_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
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
          iva_account_code: string | null
          iva_operational_account: string | null
          iva_siigo_id: string | null
          iva_siigo_name: string | null
          iva_tax_id: string | null
          iva_tax_name: string | null
          iva_tax_rate: number | null
          position: number
          quantity: number
          ret_account_code: string | null
          ret_operational_account: string | null
          ret_siigo_id: string | null
          ret_siigo_name: string | null
          ret_tax_id: string | null
          ret_tax_kind: string | null
          ret_tax_name: string | null
          ret_tax_rate: number | null
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
          iva_account_code?: string | null
          iva_operational_account?: string | null
          iva_siigo_id?: string | null
          iva_siigo_name?: string | null
          iva_tax_id?: string | null
          iva_tax_name?: string | null
          iva_tax_rate?: number | null
          position?: number
          quantity?: number
          ret_account_code?: string | null
          ret_operational_account?: string | null
          ret_siigo_id?: string | null
          ret_siigo_name?: string | null
          ret_tax_id?: string | null
          ret_tax_kind?: string | null
          ret_tax_name?: string | null
          ret_tax_rate?: number | null
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
          iva_account_code?: string | null
          iva_operational_account?: string | null
          iva_siigo_id?: string | null
          iva_siigo_name?: string | null
          iva_tax_id?: string | null
          iva_tax_name?: string | null
          iva_tax_rate?: number | null
          position?: number
          quantity?: number
          ret_account_code?: string | null
          ret_operational_account?: string | null
          ret_siigo_id?: string | null
          ret_siigo_name?: string | null
          ret_tax_id?: string | null
          ret_tax_kind?: string | null
          ret_tax_name?: string | null
          ret_tax_rate?: number | null
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
          approved_at: string | null
          approved_by: string | null
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
          import_source: string | null
          issue_date: string | null
          iva: number
          notes: string | null
          number: string | null
          paid_amount: number
          payable_account: string | null
          payable_confidence: number | null
          payable_manual: boolean
          payable_source: string | null
          payable_suggested: string | null
          payable_updated_at: string | null
          payable_updated_by: string | null
          payment_config: Json | null
          payment_enabled: boolean
          payment_form: string | null
          payment_form_manual: boolean
          payment_method: string | null
          payment_status: string
          payment_type_id: string | null
          payment_type_name: string | null
          posted_at: string | null
          posted_by: string | null
          posting_error: string | null
          prefix: string | null
          processing_at: string | null
          processing_by: string | null
          provider_address: string | null
          provider_city: string | null
          provider_email: string | null
          provider_name: string | null
          provider_nit: string | null
          provider_phone: string | null
          purchase_import_data: Json | null
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
          siigo_trace: Json | null
          status: string
          subtotal: number
          sync_applied_at: string | null
          sync_event_id: string | null
          sync_source_invoice_id: string | null
          sync_source_label: string | null
          total: number
          updated_at: string
          voucher_number: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
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
          import_source?: string | null
          issue_date?: string | null
          iva?: number
          notes?: string | null
          number?: string | null
          paid_amount?: number
          payable_account?: string | null
          payable_confidence?: number | null
          payable_manual?: boolean
          payable_source?: string | null
          payable_suggested?: string | null
          payable_updated_at?: string | null
          payable_updated_by?: string | null
          payment_config?: Json | null
          payment_enabled?: boolean
          payment_form?: string | null
          payment_form_manual?: boolean
          payment_method?: string | null
          payment_status?: string
          payment_type_id?: string | null
          payment_type_name?: string | null
          posted_at?: string | null
          posted_by?: string | null
          posting_error?: string | null
          prefix?: string | null
          processing_at?: string | null
          processing_by?: string | null
          provider_address?: string | null
          provider_city?: string | null
          provider_email?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          provider_phone?: string | null
          purchase_import_data?: Json | null
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
          siigo_trace?: Json | null
          status?: string
          subtotal?: number
          sync_applied_at?: string | null
          sync_event_id?: string | null
          sync_source_invoice_id?: string | null
          sync_source_label?: string | null
          total?: number
          updated_at?: string
          voucher_number?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
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
          import_source?: string | null
          issue_date?: string | null
          iva?: number
          notes?: string | null
          number?: string | null
          paid_amount?: number
          payable_account?: string | null
          payable_confidence?: number | null
          payable_manual?: boolean
          payable_source?: string | null
          payable_suggested?: string | null
          payable_updated_at?: string | null
          payable_updated_by?: string | null
          payment_config?: Json | null
          payment_enabled?: boolean
          payment_form?: string | null
          payment_form_manual?: boolean
          payment_method?: string | null
          payment_status?: string
          payment_type_id?: string | null
          payment_type_name?: string | null
          posted_at?: string | null
          posted_by?: string | null
          posting_error?: string | null
          prefix?: string | null
          processing_at?: string | null
          processing_by?: string | null
          provider_address?: string | null
          provider_city?: string | null
          provider_email?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          provider_phone?: string | null
          purchase_import_data?: Json | null
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
          siigo_trace?: Json | null
          status?: string
          subtotal?: number
          sync_applied_at?: string | null
          sync_event_id?: string | null
          sync_source_invoice_id?: string | null
          sync_source_label?: string | null
          total?: number
          updated_at?: string
          voucher_number?: string | null
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
      iva_treatment_rules: {
        Row: {
          company_id: string
          concept: string | null
          created_at: string
          created_by: string | null
          expense_account: string | null
          id: string
          iva_account: string | null
          provider_nit: string | null
          times_used: number
          treatment: string
          updated_at: string
        }
        Insert: {
          company_id: string
          concept?: string | null
          created_at?: string
          created_by?: string | null
          expense_account?: string | null
          id?: string
          iva_account?: string | null
          provider_nit?: string | null
          times_used?: number
          treatment: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          concept?: string | null
          created_at?: string
          created_by?: string | null
          expense_account?: string | null
          id?: string
          iva_account?: string | null
          provider_nit?: string | null
          times_used?: number
          treatment?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "iva_treatment_rules_company_id_fkey"
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
      learning_rule_changes: {
        Row: {
          changed_by: string | null
          company_id: string
          created_at: string
          field: string
          field_label: string | null
          id: string
          invoice_id: string | null
          new_value: string | null
          old_value: string | null
          rule_id: string
        }
        Insert: {
          changed_by?: string | null
          company_id: string
          created_at?: string
          field: string
          field_label?: string | null
          id?: string
          invoice_id?: string | null
          new_value?: string | null
          old_value?: string | null
          rule_id: string
        }
        Update: {
          changed_by?: string | null
          company_id?: string
          created_at?: string
          field?: string
          field_label?: string | null
          id?: string
          invoice_id?: string | null
          new_value?: string | null
          old_value?: string | null
          rule_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "learning_rule_changes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learning_rule_changes_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "learning_rule_changes_rule_id_fkey"
            columns: ["rule_id"]
            isOneToOne: false
            referencedRelation: "learning_rules"
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
          iva_account: string | null
          iva_aplica: boolean
          iva_rate: number | null
          iva_treatment: string | null
          last_used_at: string | null
          otras_account: string | null
          otras_aplica: boolean
          otras_rate: number | null
          payable_account: string | null
          payment_form: string | null
          provider_name: string | null
          provider_nit: string | null
          retefuente_account: string | null
          retefuente_aplica: boolean
          retefuente_rate: number | null
          reteica_account: string | null
          reteica_aplica: boolean
          reteica_rate: number | null
          reteiva_account: string | null
          reteiva_aplica: boolean
          reteiva_rate: number | null
          retentions: string | null
          source: string
          taxes: string | null
          times_used: number
          updated_at: string
          updated_by: string | null
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
          iva_account?: string | null
          iva_aplica?: boolean
          iva_rate?: number | null
          iva_treatment?: string | null
          last_used_at?: string | null
          otras_account?: string | null
          otras_aplica?: boolean
          otras_rate?: number | null
          payable_account?: string | null
          payment_form?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          retefuente_account?: string | null
          retefuente_aplica?: boolean
          retefuente_rate?: number | null
          reteica_account?: string | null
          reteica_aplica?: boolean
          reteica_rate?: number | null
          reteiva_account?: string | null
          reteiva_aplica?: boolean
          reteiva_rate?: number | null
          retentions?: string | null
          source?: string
          taxes?: string | null
          times_used?: number
          updated_at?: string
          updated_by?: string | null
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
          iva_account?: string | null
          iva_aplica?: boolean
          iva_rate?: number | null
          iva_treatment?: string | null
          last_used_at?: string | null
          otras_account?: string | null
          otras_aplica?: boolean
          otras_rate?: number | null
          payable_account?: string | null
          payment_form?: string | null
          provider_name?: string | null
          provider_nit?: string | null
          retefuente_account?: string | null
          retefuente_aplica?: boolean
          retefuente_rate?: number | null
          reteica_account?: string | null
          reteica_aplica?: boolean
          reteica_rate?: number | null
          reteiva_account?: string | null
          reteiva_aplica?: boolean
          reteiva_rate?: number | null
          retentions?: string | null
          source?: string
          taxes?: string | null
          times_used?: number
          updated_at?: string
          updated_by?: string | null
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
      payment_receipt_lines: {
        Row: {
          account_code: string
          account_name: string | null
          company_id: string
          created_at: string
          credit: number
          debit: number
          id: string
          invoice_id: string
          position: number
          receipt_id: string
        }
        Insert: {
          account_code: string
          account_name?: string | null
          company_id: string
          created_at?: string
          credit?: number
          debit?: number
          id?: string
          invoice_id: string
          position?: number
          receipt_id: string
        }
        Update: {
          account_code?: string
          account_name?: string | null
          company_id?: string
          created_at?: string
          credit?: number
          debit?: number
          id?: string
          invoice_id?: string
          position?: number
          receipt_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipt_lines_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipt_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipt_lines_receipt_id_fkey"
            columns: ["receipt_id"]
            isOneToOne: false
            referencedRelation: "payment_receipts"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_receipt_sequences: {
        Row: {
          company_id: string
          created_at: string
          last_number: number
          prefix: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          last_number?: number
          prefix?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          last_number?: number
          prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipt_sequences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_receipts: {
        Row: {
          account_code: string
          account_name: string | null
          amount: number
          balance_after: number
          balance_before: number
          check_number: string | null
          company_id: string
          created_at: string
          created_by: string | null
          id: string
          invoice_id: string
          method: string
          notes: string | null
          payable_account: string | null
          payment_date: string
          receipt_number: string
          siigo_error: string | null
          siigo_id: string | null
          siigo_status: string
          status: string
        }
        Insert: {
          account_code: string
          account_name?: string | null
          amount: number
          balance_after?: number
          balance_before?: number
          check_number?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id: string
          method: string
          notes?: string | null
          payable_account?: string | null
          payment_date: string
          receipt_number: string
          siigo_error?: string | null
          siigo_id?: string | null
          siigo_status?: string
          status?: string
        }
        Update: {
          account_code?: string
          account_name?: string | null
          amount?: number
          balance_after?: number
          balance_before?: number
          check_number?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          invoice_id?: string
          method?: string
          notes?: string | null
          payable_account?: string | null
          payment_date?: string
          receipt_number?: string
          siigo_error?: string | null
          siigo_id?: string | null
          siigo_status?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_receipts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_receipts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      processing_jobs: {
        Row: {
          ai_result: Json | null
          attempt_count: number
          company_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          error_code: string | null
          error_message: string | null
          error_stack: string | null
          error_stage: string | null
          file_name: string
          http_status: number | null
          id: string
          invoice_id: string | null
          item_id: string | null
          job_type: string
          lease_until: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json | null
          priority: number
          processing_stage: string | null
          retryable: boolean
          started_at: string | null
          status: string
          storage_bucket: string
          storage_path: string | null
          updated_at: string
          upload_id: string | null
          user_message: string | null
        }
        Insert: {
          ai_result?: Json | null
          attempt_count?: number
          company_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_code?: string | null
          error_message?: string | null
          error_stack?: string | null
          error_stage?: string | null
          file_name?: string
          http_status?: number | null
          id?: string
          invoice_id?: string | null
          item_id?: string | null
          job_type?: string
          lease_until?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json | null
          priority?: number
          processing_stage?: string | null
          retryable?: boolean
          started_at?: string | null
          status?: string
          storage_bucket?: string
          storage_path?: string | null
          updated_at?: string
          upload_id?: string | null
          user_message?: string | null
        }
        Update: {
          ai_result?: Json | null
          attempt_count?: number
          company_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_code?: string | null
          error_message?: string | null
          error_stack?: string | null
          error_stage?: string | null
          file_name?: string
          http_status?: number | null
          id?: string
          invoice_id?: string | null
          item_id?: string | null
          job_type?: string
          lease_until?: string | null
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json | null
          priority?: number
          processing_stage?: string | null
          retryable?: boolean
          started_at?: string | null
          status?: string
          storage_bucket?: string
          storage_path?: string | null
          updated_at?: string
          upload_id?: string | null
          user_message?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "processing_jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processing_jobs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processing_jobs_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "bulk_upload_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "processing_jobs_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "bulk_uploads"
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
          purchase_tax_profile: Json
          regime: string | null
          siigo_id: string | null
          siigo_sync_status: string | null
          siigo_synced_at: string | null
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
          purchase_tax_profile?: Json
          regime?: string | null
          siigo_id?: string | null
          siigo_sync_status?: string | null
          siigo_synced_at?: string | null
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
          purchase_tax_profile?: Json
          regime?: string | null
          siigo_id?: string | null
          siigo_sync_status?: string | null
          siigo_synced_at?: string | null
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
          excel_active: boolean | null
          has_children: boolean
          id: string
          is_movement: boolean
          level: string
          name: string
          nature: string
          parent_code: string | null
          requires_cost_center: boolean
          siigo_active: boolean | null
          siigo_code: string | null
          siigo_id: string | null
          siigo_is_movement: boolean | null
          siigo_seen_at: string | null
          source: string
          synced_at: string | null
        }
        Insert: {
          active?: boolean
          code: string
          company_id: string
          created_at?: string
          excel_active?: boolean | null
          has_children?: boolean
          id?: string
          is_movement?: boolean
          level?: string
          name: string
          nature?: string
          parent_code?: string | null
          requires_cost_center?: boolean
          siigo_active?: boolean | null
          siigo_code?: string | null
          siigo_id?: string | null
          siigo_is_movement?: boolean | null
          siigo_seen_at?: string | null
          source?: string
          synced_at?: string | null
        }
        Update: {
          active?: boolean
          code?: string
          company_id?: string
          created_at?: string
          excel_active?: boolean | null
          has_children?: boolean
          id?: string
          is_movement?: boolean
          level?: string
          name?: string
          nature?: string
          parent_code?: string | null
          requires_cost_center?: boolean
          siigo_active?: boolean | null
          siigo_code?: string | null
          siigo_id?: string | null
          siigo_is_movement?: boolean | null
          siigo_seen_at?: string | null
          source?: string
          synced_at?: string | null
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
      purchase_import_items: {
        Row: {
          choices: Json
          company_id: string
          created_at: string
          document: Json
          error_message: string | null
          id: string
          invoice_id: string | null
          position: number
          status: string
          updated_at: string
          upload_id: string
        }
        Insert: {
          choices?: Json
          company_id: string
          created_at?: string
          document: Json
          error_message?: string | null
          id?: string
          invoice_id?: string | null
          position: number
          status?: string
          updated_at?: string
          upload_id: string
        }
        Update: {
          choices?: Json
          company_id?: string
          created_at?: string
          document?: Json
          error_message?: string | null
          id?: string
          invoice_id?: string | null
          position?: number
          status?: string
          updated_at?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_import_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_import_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_import_items_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "bulk_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_import_settings: {
        Row: {
          company_id: string
          config: Json
          updated_at: string
        }
        Insert: {
          company_id: string
          config?: Json
          updated_at?: string
        }
        Update: {
          company_id?: string
          config?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_import_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
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
      siigo_payment_types: {
        Row: {
          account_code: string | null
          account_name: string | null
          active: boolean
          company_id: string
          created_at: string
          due_date_required: boolean
          id: string
          method: string
          name: string
          raw: Json | null
          siigo_id: string
          synced_at: string
          type: string | null
        }
        Insert: {
          account_code?: string | null
          account_name?: string | null
          active?: boolean
          company_id: string
          created_at?: string
          due_date_required?: boolean
          id?: string
          method?: string
          name: string
          raw?: Json | null
          siigo_id: string
          synced_at?: string
          type?: string | null
        }
        Update: {
          account_code?: string | null
          account_name?: string | null
          active?: boolean
          company_id?: string
          created_at?: string
          due_date_required?: boolean
          id?: string
          method?: string
          name?: string
          raw?: Json | null
          siigo_id?: string
          synced_at?: string
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "siigo_payment_types_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
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
          siigo_code: string | null
          siigo_id: string | null
          siigo_name: string | null
          siigo_synced_at: string | null
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
          siigo_code?: string | null
          siigo_id?: string | null
          siigo_name?: string | null
          siigo_synced_at?: string | null
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
          siigo_code?: string | null
          siigo_id?: string | null
          siigo_name?: string | null
          siigo_synced_at?: string | null
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
      voucher_sequences: {
        Row: {
          company_id: string
          created_at: string
          last_number: number
          prefix: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          last_number?: number
          prefix?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          last_number?: number
          prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_sequences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
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
      apply_draft_sync_changes: {
        Args: { _changes: Json; _invoice_id: string; _reverse?: boolean }
        Returns: number
      }
      cancel_upload_jobs: { Args: { _upload_id: string }; Returns: number }
      claim_jobs: {
        Args: { _job_type?: string; _limit?: number; _worker_id: string }
        Returns: {
          ai_result: Json | null
          attempt_count: number
          company_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          error_code: string | null
          error_message: string | null
          error_stack: string | null
          error_stage: string | null
          file_name: string
          http_status: number | null
          id: string
          invoice_id: string | null
          item_id: string | null
          job_type: string
          lease_until: string | null
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json | null
          priority: number
          processing_stage: string | null
          retryable: boolean
          started_at: string | null
          status: string
          storage_bucket: string
          storage_path: string | null
          updated_at: string
          upload_id: string | null
          user_message: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "processing_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      confirm_excel_purchase: {
        Args: {
          _choices: Json
          _item_id: string
          _journal: Json
          _retentions: Json
        }
        Returns: string
      }
      confirm_excel_purchase_validated: {
        Args: {
          _actor: string
          _choices: Json
          _item_id: string
          _journal: Json
          _retentions: Json
        }
        Returns: string
      }
      create_payment_receipt: {
        Args: {
          _account_code: string
          _account_name?: string
          _amount?: number
          _check_number?: string
          _invoice_id: string
          _method: string
          _notes?: string
          _payment_date: string
        }
        Returns: Json
      }
      history_iva_treatment: {
        Args: { _company_id: string; _limit?: number; _nits?: string[] }
        Returns: {
          expense_account: string
          iva_account: string
          provider_nit: string
          uses: number
        }[]
      }
      history_provider_accounts: {
        Args: { _company_id: string; _limit?: number; _nits: string[] }
        Returns: {
          account_code: string
          concept: string
          provider_nit: string
          uses: number
        }[]
      }
      history_provider_payable_accounts: {
        Args: { _company_id: string; _limit?: number; _nits: string[] }
        Returns: {
          account_code: string
          credit_total: number
          provider_nit: string
          uses: number
        }[]
      }
      history_top_accounts: {
        Args: { _company_id: string; _limit?: number }
        Returns: {
          account_code: string
          concept: string
          provider_nit: string
          uses: number
        }[]
      }
      history_top_payable_accounts: {
        Args: { _company_id: string; _limit?: number }
        Returns: {
          account_code: string
          uses: number
        }[]
      }
      invoice_payable_amount: { Args: { _invoice_id: string }; Returns: number }
      is_company_admin: { Args: { _company_id: string }; Returns: boolean }
      is_company_member: { Args: { _company_id: string }; Returns: boolean }
      post_invoice: { Args: { _invoice_id: string }; Returns: Json }
      provider_payable_candidates: {
        Args: { _company_id: string; _nits: string[] }
        Returns: {
          account_code: string
          last_used: string
          provider_nit: string
          source: string
          uses: number
        }[]
      }
      release_stale_jobs: { Args: { _minutes?: number }; Returns: number }
      resume_upload_jobs: {
        Args: { _include_errors?: boolean; _upload_id: string }
        Returns: number
      }
      return_invoice_to_draft: { Args: { _invoice_id: string }; Returns: Json }
      revert_invoice_posting: { Args: { _invoice_id: string }; Returns: Json }
      sync_provider_drafts: {
        Args: {
          _changes: Json
          _event_key: string
          _known?: Json
          _source_invoice_id: string
        }
        Returns: Json
      }
      undo_provider_draft_sync: { Args: { _event_id: string }; Returns: Json }
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
