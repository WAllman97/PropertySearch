import { supabase } from "../lib/supabaseClient";

export async function getSearchCriteria(userId) {
  const { data, error } = await supabase
    .from("search_criteria")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
}

export async function createSearchCriteria(criteria) {
  const { data, error } = await supabase
    .from("search_criteria")
    .insert(criteria)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateSearchCriteria(id, updates) {
  const { data, error } = await supabase
    .from("search_criteria")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteSearchCriteria(id) {
  const { error } = await supabase
    .from("search_criteria")
    .delete()
    .eq("id", id);

  if (error) throw error;
}