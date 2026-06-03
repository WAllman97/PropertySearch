from core.supabase_client import supabase

response = supabase.table("properties").select("*").limit(1).execute()

print(response)