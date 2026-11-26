output "public_ip" {
  description = "Public IP address of the server."
  value       = oci_core_instance.this.public_ip
}

output "ssh_command" {
  description = "Connect to the server."
  value       = "ssh ubuntu@${oci_core_instance.this.public_ip}"
}

output "install_command" {
  description = "Next step: install mail-me on the server (run from your mail-me folder)."
  value       = "deploy/linux/install.sh ubuntu@${oci_core_instance.this.public_ip}"
}

output "push_config_command" {
  description = "Then: upload config.json, .env and sign-ins and start mail-me."
  value       = "deploy/linux/push-config.sh ubuntu@${oci_core_instance.this.public_ip}"
}

output "instance_ocid" {
  description = "OCID of the server, for the console or the OCI CLI."
  value       = oci_core_instance.this.id
}
