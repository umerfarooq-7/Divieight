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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_members: {
        Row: {
          address: string | null
          adverse_action_issued_at: string | null
          background_check_at: string | null
          background_check_result: string | null
          buyer_account_id: string
          created_at: string
          date_of_birth: string | null
          fcra_consent_at: string | null
          full_name: string
          id: string
          id_document_url: string | null
          role: string
          updated_at: string
          verification_documents: Json
          vetting_status: string
          status: string
          email: string | null
          phone: string | null
          added_at: string
          removed_at: string | null
          id_document_number: string | null
        }
        Insert: {
          address?: string | null
          adverse_action_issued_at?: string | null
          background_check_at?: string | null
          background_check_result?: string | null
          buyer_account_id: string
          created_at?: string
          date_of_birth?: string | null
          fcra_consent_at?: string | null
          full_name?: string
          id?: string
          id_document_url?: string | null
          role?: string
          updated_at?: string
          verification_documents?: Json
          vetting_status?: string
          status?: string
          email?: string | null
          phone?: string | null
          added_at?: string
          removed_at?: string | null
          id_document_number?: string | null
        }
        Update: {
          address?: string | null
          adverse_action_issued_at?: string | null
          background_check_at?: string | null
          background_check_result?: string | null
          buyer_account_id?: string
          created_at?: string
          date_of_birth?: string | null
          fcra_consent_at?: string | null
          full_name?: string
          id?: string
          id_document_url?: string | null
          role?: string
          updated_at?: string
          verification_documents?: Json
          vetting_status?: string
          status?: string
          email?: string | null
          phone?: string | null
          added_at?: string
          removed_at?: string | null
          id_document_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_members_buyer_account_id_fkey"
            columns: ["buyer_account_id"]
            isOneToOne: false
            referencedRelation: "buyer_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      eligibility_declarations: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          standard_version: string
          answers: Json | null
          rendered_text_snapshot: string
          declaration_hash: string
          declared_at: string
          signed_name: string | null
          attested_personally: boolean
          ip: string | null
          user_agent: string | null
          supersedes_id: string | null
          status: string
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          standard_version: string
          answers?: Json | null
          rendered_text_snapshot: string
          declaration_hash: string
          declared_at?: string
          signed_name?: string | null
          attested_personally?: boolean
          ip?: string | null
          user_agent?: string | null
          supersedes_id?: string | null
          status: string
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          standard_version?: string
          answers?: Json | null
          rendered_text_snapshot?: string
          declaration_hash?: string
          declared_at?: string
          signed_name?: string | null
          attested_personally?: boolean
          ip?: string | null
          user_agent?: string | null
          supersedes_id?: string | null
          status?: string
          created_at?: string
        }
        Relationships: []
      }
      member_liveness_checks: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          id_document_ref: string
          selfie_url: string
          provider: string
          status: string
          reason_code: string | null
          checked_at: string | null
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          id_document_ref: string
          selfie_url: string
          provider?: string
          status: string
          reason_code?: string | null
          checked_at?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          id_document_ref?: string
          selfie_url?: string
          provider?: string
          status?: string
          reason_code?: string | null
          checked_at?: string | null
          created_at?: string
        }
        Relationships: []
      }
      eligibility_results: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          standard_version: string
          result: string
          reason_codes: string[]
          determined_at: string
          declaration_id: string
          screening_snapshot: Json
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          standard_version: string
          result: string
          reason_codes?: string[]
          determined_at?: string
          declaration_id: string
          screening_snapshot?: Json
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          standard_version?: string
          result?: string
          reason_codes?: string[]
          determined_at?: string
          declaration_id?: string
          screening_snapshot?: Json
          created_at?: string
        }
        Relationships: []
      }
      member_sanctions_screenings: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          provider: string
          status: string
          list_name: string | null
          matched_name: string | null
          resolves_id: string | null
          resolved_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          provider?: string
          status: string
          list_name?: string | null
          matched_name?: string | null
          resolves_id?: string | null
          resolved_by?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          provider?: string
          status?: string
          list_name?: string | null
          matched_name?: string | null
          resolves_id?: string | null
          resolved_by?: string | null
          created_at?: string
        }
        Relationships: []
      }
      charge_dispositions: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          declaration_id: string
          outcome: string
          offense_key: string | null
          disposition_date: string
          recorded_by: string
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          declaration_id: string
          outcome: string
          offense_key?: string | null
          disposition_date: string
          recorded_by: string
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          declaration_id?: string
          outcome?: string
          offense_key?: string | null
          disposition_date?: string
          recorded_by?: string
          created_at?: string
        }
        Relationships: []
      }
      declaration_untrue_findings: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          declaration_id: string
          finding: string
          after_closing: boolean
          recorded_by: string
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          declaration_id: string
          finding: string
          after_closing?: boolean
          recorded_by: string
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          declaration_id?: string
          finding?: string
          after_closing?: boolean
          recorded_by?: string
          created_at?: string
        }
        Relationships: []
      }
      member_w9: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          legal_name: string
          tax_classification: string
          address: string
          tin_kind: string
          tin_last4: string
          signed_name: string
          signed_at: string
          ip: string | null
          user_agent: string | null
          created_at: string
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          legal_name: string
          tax_classification: string
          address: string
          tin_kind: string
          tin_last4: string
          signed_name: string
          signed_at?: string
          ip?: string | null
          user_agent?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          legal_name?: string
          tax_classification?: string
          address?: string
          tin_kind?: string
          tin_last4?: string
          signed_name?: string
          signed_at?: string
          ip?: string | null
          user_agent?: string | null
          created_at?: string
        }
        Relationships: []
      }
      member_plaid_consents: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          text_version: string
          text_hash: string
          accepted_at: string
          ip: string | null
          user_agent: string | null
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          text_version: string
          text_hash: string
          accepted_at?: string
          ip?: string | null
          user_agent?: string | null
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          text_version?: string
          text_hash?: string
          accepted_at?: string
          ip?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      member_block2_authorizations: {
        Row: {
          id: string
          account_member_id: string
          buyer_account_id: string
          text_version: string
          text_hash: string
          accepted_at: string
          ip: string | null
          user_agent: string | null
        }
        Insert: {
          id?: string
          account_member_id: string
          buyer_account_id: string
          text_version: string
          text_hash: string
          accepted_at?: string
          ip?: string | null
          user_agent?: string | null
        }
        Update: {
          id?: string
          account_member_id?: string
          buyer_account_id?: string
          text_version?: string
          text_hash?: string
          accepted_at?: string
          ip?: string | null
          user_agent?: string | null
        }
        Relationships: []
      }
      member_authority_grants: {
        Row: {
          id: string
          buyer_account_id: string
          grantor_member_id: string
          grantee_member_id: string
          scope: string[]
          granted_at: string
          revoked_at: string | null
          grantor_typed_name: string
          document_hash: string
          ip: string | null
          user_agent: string | null
          created_at: string
        }
        Insert: {
          id?: string
          buyer_account_id: string
          grantor_member_id: string
          grantee_member_id: string
          scope: string[]
          granted_at?: string
          revoked_at?: string | null
          grantor_typed_name: string
          document_hash: string
          ip?: string | null
          user_agent?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          buyer_account_id?: string
          grantor_member_id?: string
          grantee_member_id?: string
          scope?: string[]
          granted_at?: string
          revoked_at?: string | null
          grantor_typed_name?: string
          document_hash?: string
          ip?: string | null
          user_agent?: string | null
          created_at?: string
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action_type: string
          actor_id: string | null
          actor_type: string
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          metadata: Json
        }
        Insert: {
          action_type: string
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
        }
        Update: {
          action_type?: string
          actor_id?: string | null
          actor_type?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
        }
        Relationships: []
      }
      buyer_accounts: {
        Row: {
          auth_user_id: string
          created_at: string
          email: string
          golden_ticket_issued: boolean
          golden_ticket_issued_at: string | null
          id: string
          intent: string | null
          last_activity_at: string
          lifestyle_perks_consent: boolean
          lifestyle_perks_consent_at: string | null
          lifestyle_perks_prompt_dismissed_at: string | null
          liquidity_documents: Json
          liquidity_institution: string | null
          liquidity_status: string
          liquidity_verified: boolean
          liquidity_verified_at: string | null
          non_negotiable_amenities: Json
          onboarding_status: string
          phone: string | null
          plaid_consent_at: string | null
          primary_target_market: string | null
          priority_forfeited_at: string | null
          priority_rank: number | null
          priority_rank_timestamp: string | null
          stall_warning_sent_at: string | null
          target_budget: number | null
          target_budget_bucket?: string | null
          target_zip_codes: Json
          updated_at: string
        }
        Insert: {
          auth_user_id: string
          created_at?: string
          email: string
          golden_ticket_issued?: boolean
          golden_ticket_issued_at?: string | null
          id?: string
          intent?: string | null
          last_activity_at?: string
          lifestyle_perks_consent?: boolean
          lifestyle_perks_consent_at?: string | null
          lifestyle_perks_prompt_dismissed_at?: string | null
          liquidity_documents?: Json
          liquidity_institution?: string | null
          liquidity_status?: string
          liquidity_verified?: boolean
          liquidity_verified_at?: string | null
          non_negotiable_amenities?: Json
          onboarding_status?: string
          phone?: string | null
          plaid_consent_at?: string | null
          primary_target_market?: string | null
          priority_forfeited_at?: string | null
          priority_rank?: number | null
          priority_rank_timestamp?: string | null
          stall_warning_sent_at?: string | null
          target_budget?: number | null
          target_budget_bucket?: string | null
          target_zip_codes?: Json
          updated_at?: string
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          email?: string
          golden_ticket_issued?: boolean
          golden_ticket_issued_at?: string | null
          id?: string
          intent?: string | null
          last_activity_at?: string
          lifestyle_perks_consent?: boolean
          lifestyle_perks_consent_at?: string | null
          lifestyle_perks_prompt_dismissed_at?: string | null
          liquidity_documents?: Json
          liquidity_institution?: string | null
          liquidity_status?: string
          liquidity_verified?: boolean
          liquidity_verified_at?: string | null
          non_negotiable_amenities?: Json
          onboarding_status?: string
          phone?: string | null
          plaid_consent_at?: string | null
          primary_target_market?: string | null
          priority_forfeited_at?: string | null
          priority_rank?: number | null
          priority_rank_timestamp?: string | null
          stall_warning_sent_at?: string | null
          target_budget?: number | null
          target_budget_bucket?: string | null
          target_zip_codes?: Json
          updated_at?: string
        }
        Relationships: []
      }
      buyer_enrollment_payments: {
        Row: {
          amount_cents: number
          auth_user_id: string
          buyer_account_id: string
          created_at: string
          currency: string
          environment: string
          id: string
          status: string
          stripe_session_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          auth_user_id: string
          buyer_account_id: string
          created_at?: string
          currency?: string
          environment?: string
          id?: string
          status?: string
          stripe_session_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          auth_user_id?: string
          buyer_account_id?: string
          created_at?: string
          currency?: string
          environment?: string
          id?: string
          status?: string
          stripe_session_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "buyer_enrollment_payments_buyer_account_id_fkey"
            columns: ["buyer_account_id"]
            isOneToOne: false
            referencedRelation: "buyer_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      contact_submissions: {
        Row: {
          created_at: string
          email: string
          id: string
          message: string
          name: string
          phone: string | null
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          message: string
          name: string
          phone?: string | null
          status?: string
          subject: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          message?: string
          name?: string
          phone?: string | null
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: []
      }
      enrollment_payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          environment: string
          id: string
          property_id: string | null
          retained_shares: number
          seller_id: string
          status: string
          stripe_session_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          environment?: string
          id?: string
          property_id?: string | null
          retained_shares: number
          seller_id: string
          status?: string
          stripe_session_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          environment?: string
          id?: string
          property_id?: string | null
          retained_shares?: number
          seller_id?: string
          status?: string
          stripe_session_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrollment_payments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enrollment_payments_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "sellers"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          message: string
          seller_id: string
          type: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          message: string
          seller_id: string
          type?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          message?: string
          seller_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "sellers"
            referencedColumns: ["id"]
          },
        ]
      }
      pod_reservations: {
        Row: {
          buyer_account_id: string
          created_at: string
          id: string
          property_id: string
          reserved_at: string
          shares_reserved: number
          status: string
          updated_at: string
        }
        Insert: {
          buyer_account_id: string
          created_at?: string
          id?: string
          property_id: string
          reserved_at?: string
          shares_reserved?: number
          status?: string
          updated_at?: string
        }
        Update: {
          buyer_account_id?: string
          created_at?: string
          id?: string
          property_id?: string
          reserved_at?: string
          shares_reserved?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pod_reservations_buyer_account_id_fkey"
            columns: ["buyer_account_id"]
            isOneToOne: false
            referencedRelation: "buyer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pod_reservations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          address: string
          amenities: Json
          bathrooms: number | null
          bedrooms: number | null
          city: string
          co_owners: Json
          created_at: string
          description: string | null
          encumbrances: Json
          exit_type: string | null
          hard_locked: boolean
          hard_locked_at: string | null
          has_co_owners: boolean
          id: string
          listing_price: number | null
          listing_status: Database["public"]["Enums"]["listing_status"]
          property_type: string | null
          retained_shares: number | null
          seller_id: string
          square_footage: number | null
          state: string
          status: string
          supporting_documents: Json
          updated_at: string
          usage_tag: string | null
          zip: string
        }
        Insert: {
          address: string
          amenities?: Json
          bathrooms?: number | null
          bedrooms?: number | null
          city: string
          co_owners?: Json
          created_at?: string
          description?: string | null
          encumbrances?: Json
          exit_type?: string | null
          hard_locked?: boolean
          hard_locked_at?: string | null
          has_co_owners?: boolean
          id?: string
          listing_price?: number | null
          listing_status?: Database["public"]["Enums"]["listing_status"]
          property_type?: string | null
          retained_shares?: number | null
          seller_id: string
          square_footage?: number | null
          state: string
          status?: string
          supporting_documents?: Json
          updated_at?: string
          usage_tag?: string | null
          zip: string
        }
        Update: {
          address?: string
          amenities?: Json
          bathrooms?: number | null
          bedrooms?: number | null
          city?: string
          co_owners?: Json
          created_at?: string
          description?: string | null
          encumbrances?: Json
          exit_type?: string | null
          hard_locked?: boolean
          hard_locked_at?: string | null
          has_co_owners?: boolean
          id?: string
          listing_price?: number | null
          listing_status?: Database["public"]["Enums"]["listing_status"]
          property_type?: string | null
          retained_shares?: number | null
          seller_id?: string
          square_footage?: number | null
          state?: string
          status?: string
          supporting_documents?: Json
          updated_at?: string
          usage_tag?: string | null
          zip?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "sellers"
            referencedColumns: ["id"]
          },
        ]
      }
      property_documents: {
        Row: {
          document_name: string
          document_type: string
          file_url: string
          id: string
          property_id: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          document_name: string
          document_type?: string
          file_url: string
          id?: string
          property_id: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          document_name?: string
          document_type?: string
          file_url?: string
          id?: string
          property_id?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_documents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      property_media: {
        Row: {
          caption: string | null
          created_at: string
          display_order: number
          id: string
          media_type: string
          narrative: string | null
          property_id: string
          updated_at: string
          url: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string
          display_order?: number
          id?: string
          media_type?: string
          narrative?: string | null
          property_id: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string
          display_order?: number
          id?: string
          media_type?: string
          narrative?: string | null
          property_id?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "property_media_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      sellers: {
        Row: {
          address: string | null
          created_at: string
          date_of_birth: string | null
          email: string
          exit_type: string | null
          full_name: string
          id: string
          id_document_url: string | null
          onboarding_status: string
          phone: string | null
          retained_shares: number | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          email: string
          exit_type?: string | null
          full_name?: string
          id: string
          id_document_url?: string | null
          onboarding_status?: string
          phone?: string | null
          retained_shares?: number | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          created_at?: string
          date_of_birth?: string | null
          email?: string
          exit_type?: string | null
          full_name?: string
          id?: string
          id_document_url?: string | null
          onboarding_status?: string
          phone?: string | null
          retained_shares?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      signed_documents: {
        Row: {
          buyer_account_id: string | null
          created_at: string
          document_hash: string | null
          document_type: string
          document_version: string
          id: string
          ip_address: string | null
          property_id: string | null
          seller_id: string | null
          signed_name: string
          account_member_id: string | null
          user_agent: string | null
          acted_by_member_id: string | null
          on_behalf_of_member_id: string | null
          authority_grant_id: string | null
        }
        Insert: {
          buyer_account_id?: string | null
          created_at?: string
          document_hash?: string | null
          document_type: string
          document_version: string
          id?: string
          ip_address?: string | null
          property_id?: string | null
          seller_id?: string | null
          signed_name: string
          account_member_id?: string | null
          user_agent?: string | null
          acted_by_member_id?: string | null
          on_behalf_of_member_id?: string | null
          authority_grant_id?: string | null
        }
        Update: {
          buyer_account_id?: string | null
          created_at?: string
          document_hash?: string | null
          document_type?: string
          document_version?: string
          id?: string
          ip_address?: string | null
          property_id?: string | null
          seller_id?: string | null
          signed_name?: string
          account_member_id?: string | null
          user_agent?: string | null
          acted_by_member_id?: string | null
          on_behalf_of_member_id?: string | null
          authority_grant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signed_documents_buyer_account_id_fkey"
            columns: ["buyer_account_id"]
            isOneToOne: false
            referencedRelation: "buyer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signed_documents_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "signed_documents_seller_id_fkey"
            columns: ["seller_id"]
            isOneToOne: false
            referencedRelation: "sellers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      wishlist: {
        Row: {
          buyer_account_id: string
          created_at: string
          id: string
          property_id: string
        }
        Insert: {
          buyer_account_id: string
          created_at?: string
          id?: string
          property_id: string
        }
        Update: {
          buyer_account_id?: string
          created_at?: string
          id?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "wishlist_buyer_account_id_fkey"
            columns: ["buyer_account_id"]
            isOneToOne: false
            referencedRelation: "buyer_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wishlist_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      listing_status: "forming" | "system_lock" | "closing_ready" | "active"
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
    Enums: {
      app_role: ["admin", "moderator", "user"],
      listing_status: ["forming", "system_lock", "closing_ready", "active"],
    },
  },
} as const
