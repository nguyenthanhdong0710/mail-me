locals {
  labels = { app = "mail-me" }
  tag    = "mail-me"
}

# New projects have the Compute Engine API turned off. Leave it on when destroying: other things
# in the project may use it.
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_network" "this" {
  name                    = "${var.display_name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.compute]
}

resource "google_compute_subnetwork" "this" {
  name          = "${var.display_name}-subnet"
  network       = google_compute_network.this.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

# mail-me only makes outbound connections (IMAP, HTTPS, SMTP, Telegram), so the only inbound rule
# is SSH for you. A new VPC denies all other inbound traffic by default.
resource "google_compute_firewall" "ssh" {
  name          = "${var.display_name}-allow-ssh"
  network       = google_compute_network.this.id
  direction     = "INGRESS"
  source_ranges = [var.ssh_source_cidr]
  target_tags   = [local.tag]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
