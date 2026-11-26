# Locally the provider reads ~/.oci/config (DEFAULT profile, or OCI_CLI_PROFILE / TF_VAR_* /
# OCI_* environment variables). In OCI Resource Manager it uses the service's own auth.
provider "oci" {
  region = var.region
}
