# Uses Application Default Credentials: run `gcloud auth application-default login` once.
provider "google" {
  project = var.project_id
  region  = var.region
}
